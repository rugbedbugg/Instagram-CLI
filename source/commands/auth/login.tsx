import React, {useState, useEffect, useCallback, useMemo} from 'react';
import {Box, Text} from 'ink';
import {Alert, TextInput} from '@inkjs/ui';
import zod from 'zod';
import {option} from 'pastel';
import LoginForm from '../../ui/components/login-form.js';
import {InstagramClient} from '../../client.js';
import {AuthenticationCoordinator} from '../../auth/coordinator.js';
import {
	describeAuthenticationOutcome,
	nextAuthenticationStep,
	type AuthenticationOutcome,
} from '../../auth/outcomes.js';
import {ConfigManager} from '../../config.js';
import {createContextualLogger} from '../../utils/logger.js';

export const description = 'Login to Instagram';

const logger = createContextualLogger('LoginCommand');

export const options = zod.object({
	refresh: zod
		.boolean()
		.default(false)
		.describe(
			option({
				alias: 'r',
				description: 'Force re-login with username/password (interactive form)',
			}),
		),
	username: zod
		.string()
		.optional()
		.describe(
			option({
				alias: 'u',
				description: 'Username for non-interactive login (requires --password)',
			}),
		),
	password: zod
		.string()
		.optional()
		.describe(
			option({
				alias: 'p',
				description: 'Password for non-interactive login (requires --username)',
			}),
		),
	totp: zod
		.string()
		.optional()
		.describe(
			option({
				description: 'TOTP code for non-interactive 2FA login',
			}),
		),
});

type Properties = {
	readonly options: zod.infer<typeof options>;
};

type Mode = 'session' | 'form' | 'code' | 'success' | 'error';

const smsHint =
	' If you do not receive a code, go to Instagram Settings → Accounts Center → Password and security → Two-factor authentication → Additional methods, and turn off "Login requests". This can prevent the SMS code from being sent.';

type LoginView = {
	setMessage(message: string | undefined): void;
	setMode(mode: Mode): void;
	attach(client: InstagramClient): AuthenticationCoordinator;
};

/**
 * Show an outcome. A checkpoint asks Instagram for a code once, as before;
 * every other next step waits for the user.
 */
async function present(
	outcome: AuthenticationOutcome,
	active: AuthenticationCoordinator,
	context: {interactive: boolean; restoring: boolean},
	view: LoginView,
	mayRequestCheckpointCode = true,
): Promise<void> {
	// A second Enter while a step runs is refused; the first one reports.
	if (outcome.kind === 'failed' && outcome.reason === 'busy') {
		return;
	}

	logger.info(`Authentication outcome: ${outcome.kind}`);
	const text = describeAuthenticationOutcome(outcome);
	const step = nextAuthenticationStep(outcome);
	if (step === 'request-checkpoint-code') {
		if (!context.interactive || !mayRequestCheckpointCode) {
			view.setMessage(
				`${text} Run \`insta-cli auth login\` interactively to complete it.`,
			);
			view.setMode('error');
			return;
		}

		view.setMessage('Challenge required. Requesting code...');
		await present(
			await active.requestCheckpointCode(),
			active,
			context,
			view,
			false,
		);
		return;
	}

	if (step === 'done') {
		view.setMessage(text);
		view.setMode('success');
		return;
	}

	if (step === 'enter-verification-code' && context.interactive) {
		const sms =
			outcome.kind === 'two-factor-required' &&
			outcome.challenge.method === 'sms';
		view.setMessage(sms ? `${text}${smsHint}` : text);
		view.setMode('code');
		return;
	}

	if (
		step === 'enter-credentials' &&
		context.interactive &&
		context.restoring
	) {
		view.setMessage(text);
		view.attach(new InstagramClient());
		view.setMode('form');
		return;
	}

	view.setMessage(text);
	view.setMode('error');
}

export default function Login({options}: Properties) {
	const [client, setClient] = useState<InstagramClient | undefined>(undefined);
	const [coordinator, setCoordinator] = useState<
		AuthenticationCoordinator | undefined
	>(undefined);
	const [message, setMessage] = useState<string | undefined>('Initializing...');
	const [mode, setMode] = useState<Mode>('session');

	// Effect to handle client shutdown when the component unmounts
	useEffect(() => {
		return () => {
			if (client) {
				void client.shutdown();
			}
		};
	}, [client]);

	const attach = useCallback(
		(next: InstagramClient): AuthenticationCoordinator => {
			const nextCoordinator = new AuthenticationCoordinator(next);
			setClient(next);
			setCoordinator(nextCoordinator);
			return nextCoordinator;
		},
		[],
	);
	const view = useMemo<LoginView>(
		() => ({setMessage, setMode, attach}),
		[attach],
	);

	const handleLoginSubmit = async (username: string, password: string) => {
		if (!coordinator) return;

		logger.info(`Login attempt for user: ${username}`);
		setMessage(`Logging in as @${username}...`);
		const outcome = await coordinator.loginWithCredentials(username, password, {
			initializeRealtime: false,
		});
		await present(
			outcome,
			coordinator,
			{interactive: true, restoring: false},
			view,
		);
	};

	const handleCodeSubmit = async (code: string) => {
		if (!coordinator) return;

		setMessage('Verifying code...');
		const outcome = await coordinator.submitVerificationCode(code);
		await present(
			outcome,
			coordinator,
			{interactive: true, restoring: false},
			view,
		);
	};

	useEffect(() => {
		const run = async () => {
			// Non-interactive mode: --username and --password provided
			if (options.username && options.password) {
				const active = attach(new InstagramClient());
				const context = {interactive: false, restoring: false};
				setMessage(`Logging in as @${options.username}...`);

				const outcome = await active.loginWithCredentials(
					options.username,
					options.password,
					{initializeRealtime: false},
				);

				if (outcome.kind === 'two-factor-required') {
					if (!options.totp) {
						setMessage(
							'2FA required but no --totp code provided. Pass --totp <code> for non-interactive 2FA.',
						);
						setMode('error');
						return;
					}

					setMessage('Verifying TOTP code...');
					await present(
						await active.submitVerificationCode(options.totp),
						active,
						context,
						view,
					);
					return;
				}

				await present(outcome, active, context, view);
				return;
			}

			// If the user provided the --refresh flag, show interactive form
			if (options.refresh) {
				attach(new InstagramClient());
				setMode('form');
				setMessage(undefined);
				return;
			}

			// Otherwise we load the saved session and if failed redirect to form
			setMessage('Trying to log in with saved session...');
			const config = ConfigManager.getInstance();
			await config.initialize();
			const currentUsername = config.get('login.currentUsername');

			if (!currentUsername) {
				setMessage(
					'No saved session found. Please log in with your username and password.',
				);
				attach(new InstagramClient());
				setMode('form');
				return;
			}

			const active = attach(new InstagramClient(currentUsername));
			const outcome = await active.restoreSession({initializeRealtime: false});
			await present(
				outcome,
				active,
				{interactive: true, restoring: true},
				view,
			);
		};

		void run();
	}, [
		options.refresh,
		options.username,
		options.password,
		options.totp,
		attach,
		view,
	]);

	if (mode === 'error') {
		return (
			<Box>
				<Alert variant="error">{message}</Alert>
			</Box>
		);
	}

	if (mode === 'success') {
		return (
			<Box>
				<Alert variant="success">{message}</Alert>
			</Box>
		);
	}

	if (mode === 'session') {
		return (
			<Box>
				<Alert variant="info">{message}</Alert>
			</Box>
		);
	}

	if (mode === 'form') {
		return (
			<>
				{message && <Text>{message}</Text>}
				<LoginForm
					onSubmit={(username, password) => {
						void handleLoginSubmit(username, password);
					}}
				/>
			</>
		);
	}

	if (mode === 'code') {
		return (
			<>
				{message && <Text>{message}</Text>}
				<Box>
					<Text>Enter verification code: </Text>
					<TextInput
						placeholder="Enter code and press Enter"
						onSubmit={code => {
							void handleCodeSubmit(code);
						}}
					/>
				</Box>
			</>
		);
	}

	return <Text>Initializing...</Text>;
}
