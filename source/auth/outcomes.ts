import {
	IgActionSpamError,
	IgChallengeWrongCodeError,
	IgCheckpointError,
	IgInactiveUserError,
	IgLoginBadPasswordError,
	IgLoginInvalidUserError,
	IgLoginRequiredError,
	IgLoginTwoFactorRequiredError,
	IgNetworkError,
	IgNoCheckpointError,
	IgResponseError,
	IgSentryBlockError,
	IgUserHasLoggedOutError,
} from 'instagram-private-api';
import type {SessionMaterialCheck} from './authorization.js';

/** Methods the existing 2FA endpoint accepts: TOTP ('0') or SMS ('1'). */
export type TwoFactorMethod = 'totp' | 'sms';

/** Transient 2FA context; held in memory only, never persisted or logged. */
export type TwoFactorChallenge = {
	readonly identifier: string;
	readonly method: TwoFactorMethod;
};

/**
 * Every result an authentication step can produce. Only `authenticated` and
 * `session-validated` mean the server accepted the session; a restored session
 * is unverified until a request made with it succeeds.
 */
export type AuthenticationOutcome =
	| {
			readonly kind: 'authenticated';
			readonly username: string;
			readonly via: 'credentials' | 'two-factor' | 'challenge';
			readonly persisted: boolean;
	  }
	| {readonly kind: 'session-validated'; readonly username: string}
	| {readonly kind: 'session-restored-unverified'; readonly username: string}
	| {readonly kind: 'no-session'; readonly reason: 'missing' | 'unusable'}
	| {
			readonly kind: 'two-factor-required';
			readonly challenge: TwoFactorChallenge;
	  }
	| {readonly kind: 'checkpoint-required'}
	| {
			readonly kind: 'checkpoint-code-sent';
			readonly contactPoint: 'email' | 'phone';
	  }
	| {readonly kind: 'checkpoint-cleared'}
	| {
			readonly kind: 'invalid-credentials';
			readonly reason: 'bad-password' | 'invalid-user';
	  }
	| {readonly kind: 'verification-code-rejected'}
	| {readonly kind: 'rate-limited'}
	| {readonly kind: 'session-expired'}
	| {readonly kind: 'network-error'}
	| {readonly kind: 'unsupported-challenge'; readonly step: string | undefined}
	| {
			readonly kind: 'incompatible-response';
			readonly reason:
				| Extract<SessionMaterialCheck, {established: false}>['reason']
				| 'malformed-response'
				| 'malformed-two-factor';
	  }
	| {readonly kind: 'account-restricted'}
	| {
			readonly kind: 'failed';
			readonly reason:
				| 'busy'
				| 'invalid-state'
				| 'no-checkpoint'
				| 'unexpected-error';
			readonly status?: number;
	  };

export type AuthenticationOutcomeKind = AuthenticationOutcome['kind'];

/** What the user can do next; the client never takes these steps by itself. */
export type NextAuthenticationStep =
	| 'done'
	| 'enter-credentials'
	| 'enter-verification-code'
	| 'request-checkpoint-code'
	| 'stop';

export function nextAuthenticationStep(
	outcome: AuthenticationOutcome,
): NextAuthenticationStep {
	switch (outcome.kind) {
		case 'authenticated':
		case 'session-validated':
		case 'session-restored-unverified': {
			return 'done';
		}

		case 'no-session':
		case 'session-expired':
		case 'invalid-credentials':
		case 'checkpoint-cleared':
		case 'incompatible-response': {
			return 'enter-credentials';
		}

		case 'two-factor-required':
		case 'checkpoint-code-sent':
		case 'verification-code-rejected': {
			return 'enter-verification-code';
		}

		case 'checkpoint-required': {
			return 'request-checkpoint-code';
		}

		case 'rate-limited':
		case 'network-error':
		case 'unsupported-challenge':
		case 'account-restricted':
		case 'failed': {
			return 'stop';
		}
	}
}

/** Challenge steps that ask for an emailed or texted security code. */
const codeEntrySteps = new Set([
	'verify_email',
	'verify_email_code',
	'verify_phone',
	'verify_phone_code',
	'verify_sms',
	'verify_sms_code',
]);

/** A server-provided step name, kept only when it is a plain identifier. */
export function challengeStepName(challenge: unknown): string | undefined {
	if (typeof challenge !== 'object' || challenge === null) {
		return undefined;
	}

	const {step_name: step} = challenge as Record<string, unknown>;
	return typeof step === 'string' && /^[a-z_]{1,64}$/.test(step)
		? step
		: undefined;
}

export function classifyChallengeStep(
	step: string | undefined,
): AuthenticationOutcome {
	if (step !== undefined && codeEntrySteps.has(step)) {
		return {
			kind: 'checkpoint-code-sent',
			contactPoint: /phone|sms/.test(step) ? 'phone' : 'email',
		};
	}

	return {kind: 'unsupported-challenge', step};
}

function parseTwoFactor(info: unknown): AuthenticationOutcome {
	if (typeof info !== 'object' || info === null) {
		return {kind: 'incompatible-response', reason: 'malformed-two-factor'};
	}

	const {two_factor_identifier: identifier, totp_two_factor_on: totp} =
		info as Record<string, unknown>;
	if (typeof identifier !== 'string' || identifier.length === 0) {
		return {kind: 'incompatible-response', reason: 'malformed-two-factor'};
	}

	return {
		kind: 'two-factor-required',
		challenge: {identifier, method: totp === true ? 'totp' : 'sms'},
	};
}

function responseStatus(error: IgResponseError): number | undefined {
	const status: unknown = error.response?.statusCode;
	return typeof status === 'number' ? status : undefined;
}

function responseMessage(error: IgResponseError): string {
	const body: unknown = error.response?.body;
	if (typeof body === 'object' && body !== null && 'message' in body) {
		return typeof body.message === 'string' ? body.message : '';
	}

	return '';
}

/** Map an error from the existing authentication flows to an outcome. */
export function classifyAuthenticationError(
	error: unknown,
): AuthenticationOutcome {
	if (error instanceof IgLoginTwoFactorRequiredError) {
		const body: unknown = error.response?.body;
		return parseTwoFactor(
			typeof body === 'object' && body !== null && 'two_factor_info' in body
				? body.two_factor_info
				: undefined,
		);
	}

	if (error instanceof IgCheckpointError) {
		return {kind: 'checkpoint-required'};
	}

	if (error instanceof IgLoginBadPasswordError) {
		return {kind: 'invalid-credentials', reason: 'bad-password'};
	}

	if (error instanceof IgLoginInvalidUserError) {
		return {kind: 'invalid-credentials', reason: 'invalid-user'};
	}

	if (error instanceof IgChallengeWrongCodeError) {
		return {kind: 'verification-code-rejected'};
	}

	if (
		error instanceof IgLoginRequiredError ||
		error instanceof IgUserHasLoggedOutError
	) {
		return {kind: 'session-expired'};
	}

	if (error instanceof IgActionSpamError) {
		return {kind: 'rate-limited'};
	}

	if (
		error instanceof IgSentryBlockError ||
		error instanceof IgInactiveUserError
	) {
		return {kind: 'account-restricted'};
	}

	if (error instanceof IgNoCheckpointError) {
		return {kind: 'failed', reason: 'no-checkpoint'};
	}

	if (error instanceof IgNetworkError) {
		// The dependency wraps an unparseable success body the same way as a
		// transport failure; the wrapped error's name tells them apart.
		return error.name === 'TransformError'
			? {kind: 'incompatible-response', reason: 'malformed-response'}
			: {kind: 'network-error'};
	}

	if (error instanceof IgResponseError) {
		const status = responseStatus(error);
		// 429, and instagrapi's "Please wait a few minutes" throttling message.
		if (
			status === 429 ||
			responseMessage(error).includes('Please wait a few minutes')
		) {
			return {kind: 'rate-limited'};
		}

		// A 2xx the dependency still rejected lacked the expected `status: ok`.
		if (status !== undefined && status >= 200 && status < 300) {
			return {kind: 'incompatible-response', reason: 'malformed-response'};
		}

		return {kind: 'failed', reason: 'unexpected-error', status};
	}

	return {kind: 'failed', reason: 'unexpected-error'};
}

/** Error class and HTTP status only: safe for logs, never a server body. */
export function describeAuthenticationError(error: unknown): string {
	if (!(error instanceof Error)) {
		return typeof error;
	}

	const status =
		error instanceof IgResponseError ? responseStatus(error) : undefined;
	return status === undefined ? error.name : `${error.name} (HTTP ${status})`;
}

/** User-facing text. Never includes credentials, codes, tokens or bodies. */
export function describeAuthenticationOutcome(
	outcome: AuthenticationOutcome,
): string {
	switch (outcome.kind) {
		case 'authenticated': {
			return outcome.persisted
				? `Logged in as @${outcome.username}`
				: `Logged in as @${outcome.username}, but the session could not be saved; you will need to log in again next time.`;
		}

		case 'session-validated': {
			return `Logged in as @${outcome.username}`;
		}

		case 'session-restored-unverified': {
			return `Restored the saved session for @${outcome.username}. Instagram could not be reached, so it is not verified yet.`;
		}

		case 'no-session': {
			return outcome.reason === 'missing'
				? 'No saved session found. Please log in with your username and password.'
				: 'The saved session holds no usable authorization. Please log in with your username and password.';
		}

		case 'two-factor-required': {
			return outcome.challenge.method === 'totp'
				? 'Two-factor authentication required. Enter the code from your authenticator app.'
				: 'Two-factor authentication required. Enter the code received via SMS.';
		}

		case 'checkpoint-required': {
			return 'Instagram requires verification before this login can continue.';
		}

		case 'checkpoint-code-sent': {
			return `A verification code has been sent to your ${outcome.contactPoint}. Please enter it below.`;
		}

		case 'checkpoint-cleared': {
			return 'Instagram closed the verification without establishing a session. Please log in again.';
		}

		case 'invalid-credentials': {
			return outcome.reason === 'bad-password'
				? "You have entered an incorrect username or password. If you're sure your credentials are correct, this might be caused by Instagram's IP blocking system, try again in a few hours."
				: 'Instagram did not recognise that username.';
		}

		case 'verification-code-rejected': {
			return 'The verification code was not accepted. Check it and enter it again.';
		}

		case 'rate-limited': {
			return 'Instagram is rate limiting requests. Wait before trying again; nothing is retried automatically.';
		}

		case 'session-expired': {
			return 'The saved session has expired or was logged out. Please log in with your username and password. The saved file was kept.';
		}

		case 'network-error': {
			return 'Could not reach Instagram (network failure). Any saved session was kept.';
		}

		case 'unsupported-challenge': {
			return `Instagram requested a verification step this CLI does not support${
				outcome.step ? ` (${outcome.step})` : ''
			}. Complete it in the official app, then try again.`;
		}

		case 'incompatible-response': {
			return `Instagram's response did not establish a session (${outcome.reason}). The server may require an authentication mechanism this client does not implement.`;
		}

		case 'account-restricted': {
			return 'Instagram blocked this login or reports the account as inactive. Check the account in the official app.';
		}

		case 'failed': {
			switch (outcome.reason) {
				case 'busy': {
					return 'An authentication step is already in progress.';
				}

				case 'invalid-state': {
					return 'There is no pending verification for that code.';
				}

				case 'no-checkpoint': {
					return 'There is no pending Instagram challenge to resolve.';
				}

				case 'unexpected-error': {
					return `Authentication failed unexpectedly${
						outcome.status === undefined ? '' : ` (HTTP ${outcome.status})`
					}. See the log for details.`;
				}
			}
		}
	}
}
