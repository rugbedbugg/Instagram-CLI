import test from 'ava';
import {
	IgActionSpamError,
	IgChallengeWrongCodeError,
	IgCheckpointError,
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
import {
	AuthenticationCoordinator,
	type AuthenticationClient,
} from '../../source/auth/coordinator.js';
import {
	classifyAuthenticationError,
	classifyChallengeStep,
	describeAuthenticationError,
	describeAuthenticationOutcome,
	nextAuthenticationStep,
	type AuthenticationOutcome,
	type AuthenticationOutcomeKind,
} from '../../source/auth/outcomes.js';
import {
	syntheticCode,
	syntheticPassword,
	syntheticSessionId,
	syntheticTwoFactorIdentifier,
} from './_offline-instagram.js';

// A partial response: only the fields the error constructors and classifier
// read. Typed `never` so it can stand in for each error's response type.
type SyntheticResponse = never;
type ErrorClass = new (response: SyntheticResponse) => Error;

function response(status: number, body: unknown): SyntheticResponse {
	const partial: unknown = {
		statusCode: status,
		statusMessage: 'Synthetic',
		body,
		headers: {},
		request: {method: 'POST', uri: {path: '/api/v1/accounts/login/'}},
	};
	return partial as SyntheticResponse;
}

const responseErrors: Array<
	[ErrorClass, number, unknown, Partial<AuthenticationOutcome>]
> = [
	[
		IgLoginTwoFactorRequiredError,
		400,
		{
			two_factor_info: {
				two_factor_identifier: syntheticTwoFactorIdentifier,
				totp_two_factor_on: true,
			},
		},
		{kind: 'two-factor-required'},
	],
	[
		IgLoginTwoFactorRequiredError,
		400,
		{two_factor_info: {totp_two_factor_on: true}},
		{kind: 'incompatible-response', reason: 'malformed-two-factor'},
	],
	[IgCheckpointError, 400, {}, {kind: 'checkpoint-required'}],
	[
		IgLoginBadPasswordError,
		400,
		{},
		{kind: 'invalid-credentials', reason: 'bad-password'},
	],
	[
		IgLoginInvalidUserError,
		400,
		{},
		{kind: 'invalid-credentials', reason: 'invalid-user'},
	],
	[IgLoginRequiredError, 403, {}, {kind: 'session-expired'}],
	[IgUserHasLoggedOutError, 400, {}, {kind: 'session-expired'}],
	[IgActionSpamError, 400, {spam: true}, {kind: 'rate-limited'}],
	[IgSentryBlockError, 400, {}, {kind: 'account-restricted'}],
	[IgResponseError, 429, {}, {kind: 'rate-limited'}],
	[
		IgResponseError,
		400,
		{message: 'Please wait a few minutes before you try again.'},
		{kind: 'rate-limited'},
	],
	[
		IgResponseError,
		200,
		{},
		{kind: 'incompatible-response', reason: 'malformed-response'},
	],
	[
		IgResponseError,
		500,
		{},
		{kind: 'failed', reason: 'unexpected-error', status: 500},
	],
];

for (const [ErrorType, status, body, expected] of responseErrors) {
	test(`classifies ${ErrorType.name} (HTTP ${status}) as ${expected.kind}`, t => {
		t.like(
			classifyAuthenticationError(new ErrorType(response(status, body))),
			expected,
		);
	});
}

test('two-factor method and identifier come only from the server context', t => {
	const sms = classifyAuthenticationError(
		new IgLoginTwoFactorRequiredError(
			response(400, {
				two_factor_info: {
					two_factor_identifier: syntheticTwoFactorIdentifier,
					totp_two_factor_on: false,
				},
			}),
		),
	);
	t.deepEqual(sms, {
		kind: 'two-factor-required',
		challenge: {identifier: syntheticTwoFactorIdentifier, method: 'sms'},
	});
});

test('a transport failure is a network error, an unparseable body is not', t => {
	const transport = new IgNetworkError(
		Object.assign(new Error('ECONNRESET'), {name: 'RequestError'}),
	);
	const malformed = new IgNetworkError(
		Object.assign(new Error('Unexpected token'), {name: 'TransformError'}),
	);
	t.deepEqual(classifyAuthenticationError(transport), {kind: 'network-error'});
	t.deepEqual(classifyAuthenticationError(malformed), {
		kind: 'incompatible-response',
		reason: 'malformed-response',
	});
});

test('a refused certificate is an untrusted connection, not an outage', t => {
	const failure = (code: string) =>
		new IgNetworkError(
			Object.assign(new Error('synthetic TLS failure'), {
				name: 'RequestError',
				cause: Object.assign(new Error('synthetic'), {code}),
			}),
		);
	for (const [code, reason] of [
		['DEPTH_ZERO_SELF_SIGNED_CERT', 'certificate'],
		['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'certificate'],
		['CERT_HAS_EXPIRED', 'certificate'],
		['ERR_TLS_CERT_ALTNAME_INVALID', 'hostname'],
		['ERR_SSL_WRONG_VERSION_NUMBER', 'handshake'],
	]) {
		t.deepEqual(classifyAuthenticationError(failure(code!)), {
			kind: 'untrusted-connection',
			reason,
		});
	}

	t.deepEqual(classifyAuthenticationError(failure('ECONNREFUSED')), {
		kind: 'network-error',
	});
	t.is(
		nextAuthenticationStep({kind: 'untrusted-connection', reason: 'hostname'}),
		'stop',
	);
});

test('challenge errors and unknown errors stay typed', t => {
	t.deepEqual(
		classifyAuthenticationError(new IgChallengeWrongCodeError('wrong')),
		{kind: 'verification-code-rejected'},
	);
	t.deepEqual(classifyAuthenticationError(new IgNoCheckpointError()), {
		kind: 'failed',
		reason: 'no-checkpoint',
	});
	t.deepEqual(classifyAuthenticationError(new Error('boom')), {
		kind: 'failed',
		reason: 'unexpected-error',
	});
});

test('only evidenced code-entry challenge steps ask the user for a code', t => {
	t.deepEqual(classifyChallengeStep('verify_email'), {
		kind: 'checkpoint-code-sent',
		contactPoint: 'email',
	});
	t.deepEqual(classifyChallengeStep('verify_sms_code'), {
		kind: 'checkpoint-code-sent',
		contactPoint: 'phone',
	});
	for (const step of ['submit_phone', 'selfie_captcha', 'ufac_www_bloks']) {
		t.deepEqual(classifyChallengeStep(step), {
			kind: 'unsupported-challenge',
			step,
		});
	}

	t.deepEqual(classifyChallengeStep(undefined), {
		kind: 'unsupported-challenge',
		step: undefined,
	});
});

test('log descriptions carry the error class and status, never the body', t => {
	const error = new IgResponseError(
		response(400, {message: `leak ${syntheticSessionId} ${syntheticPassword}`}),
	);
	t.is(describeAuthenticationError(error), 'IgResponseError (HTTP 400)');
});

const everyOutcome: Record<AuthenticationOutcomeKind, AuthenticationOutcome> = {
	authenticated: {
		kind: 'authenticated',
		username: 'synthetic',
		via: 'credentials',
		persisted: false,
	},
	'session-validated': {kind: 'session-validated', username: 'synthetic'},
	'session-restored-unverified': {
		kind: 'session-restored-unverified',
		username: 'synthetic',
	},
	'no-session': {kind: 'no-session', reason: 'unusable'},
	'two-factor-required': {
		kind: 'two-factor-required',
		challenge: {identifier: syntheticTwoFactorIdentifier, method: 'sms'},
	},
	'checkpoint-required': {kind: 'checkpoint-required'},
	'checkpoint-code-sent': {kind: 'checkpoint-code-sent', contactPoint: 'email'},
	'checkpoint-cleared': {kind: 'checkpoint-cleared'},
	'invalid-credentials': {kind: 'invalid-credentials', reason: 'bad-password'},
	'verification-code-rejected': {kind: 'verification-code-rejected'},
	'rate-limited': {kind: 'rate-limited'},
	'session-expired': {kind: 'session-expired'},
	'network-error': {kind: 'network-error'},
	'untrusted-connection': {kind: 'untrusted-connection', reason: 'hostname'},
	'unsupported-challenge': {
		kind: 'unsupported-challenge',
		step: 'submit_phone',
	},
	'incompatible-response': {
		kind: 'incompatible-response',
		reason: 'missing-session',
	},
	'account-restricted': {kind: 'account-restricted'},
	failed: {kind: 'failed', reason: 'unexpected-error', status: 502},
};

test('every outcome has a distinct message without transient secrets', t => {
	const messages = Object.values(everyOutcome).map(outcome =>
		describeAuthenticationOutcome(outcome),
	);
	t.is(new Set(messages).size, messages.length);
	for (const message of messages) {
		for (const secret of [
			syntheticTwoFactorIdentifier,
			syntheticPassword,
			syntheticCode,
			syntheticSessionId,
		]) {
			t.false(message.includes(secret));
		}
	}

	t.regex(describeAuthenticationOutcome(everyOutcome['rate-limited']), /rate/);
	t.regex(
		describeAuthenticationOutcome(everyOutcome['network-error']),
		/network/,
	);
	t.regex(
		describeAuthenticationOutcome(everyOutcome['session-expired']),
		/expired/,
	);
	t.regex(
		describeAuthenticationOutcome(everyOutcome['incompatible-response']),
		/authentication mechanism/,
	);
});

test('only accepted sessions are done; failures never continue by themselves', t => {
	const done = Object.values(everyOutcome)
		.filter(outcome => nextAuthenticationStep(outcome) === 'done')
		.map(outcome => outcome.kind);
	t.deepEqual(done.sort(), [
		'authenticated',
		'session-restored-unverified',
		'session-validated',
	]);
	t.is(nextAuthenticationStep(everyOutcome['rate-limited']), 'stop');
	t.is(nextAuthenticationStep(everyOutcome['unsupported-challenge']), 'stop');
});

// ── Coordinator transitions ──────────────────────────────────────────────────

function scriptedClient(
	outcomes: Partial<Record<string, AuthenticationOutcome>>,
) {
	const calls: string[] = [];
	const respond =
		(name: string) =>
		async (...parameters: unknown[]): Promise<AuthenticationOutcome> => {
			calls.push(
				`${name}(${parameters.filter(value => typeof value !== 'object').length})`,
			);
			await new Promise(resolve => {
				setImmediate(resolve);
			});
			return outcomes[name] ?? {kind: 'failed', reason: 'unexpected-error'};
		};

	const client: AuthenticationClient = {
		loginBySession: respond('loginBySession'),
		loginBySessionId: respond('loginBySessionId'),
		login: respond('login'),
		twoFactorLogin: respond('twoFactorLogin'),
		startChallenge: respond('startChallenge'),
		sendChallengeCode: respond('sendChallengeCode'),
	};
	return {client, calls};
}

test('a duplicate submission while a step runs is refused, not sent', async t => {
	const {client, calls} = scriptedClient({
		login: {kind: 'invalid-credentials', reason: 'bad-password'},
	});
	const coordinator = new AuthenticationCoordinator(client);
	const first = coordinator.loginWithCredentials(
		'synthetic',
		syntheticPassword,
		{
			initializeRealtime: false,
		},
	);
	const second = await coordinator.loginWithCredentials(
		'synthetic',
		syntheticPassword,
		{initializeRealtime: false},
	);
	t.like(coordinator.state, {kind: 'authenticating', step: 'credentials'});
	t.deepEqual(second, {kind: 'failed', reason: 'busy'});
	t.like(await first, {kind: 'invalid-credentials'});
	t.deepEqual(calls, ['login(2)']);
	t.like(coordinator.state, {kind: 'invalid-credentials'});
});

test('a code is only submitted for a pending verification of the right kind', async t => {
	const {client, calls} = scriptedClient({
		login: {
			kind: 'two-factor-required',
			challenge: {identifier: syntheticTwoFactorIdentifier, method: 'totp'},
		},
		twoFactorLogin: {kind: 'verification-code-rejected'},
	});
	const coordinator = new AuthenticationCoordinator(client);
	t.deepEqual(await coordinator.submitVerificationCode(syntheticCode), {
		kind: 'failed',
		reason: 'invalid-state',
	});
	t.deepEqual(await coordinator.requestCheckpointCode(), {
		kind: 'failed',
		reason: 'invalid-state',
	});
	await coordinator.loginWithCredentials('synthetic', syntheticPassword, {
		initializeRealtime: false,
	});
	await coordinator.submitVerificationCode(syntheticCode);
	// A rejected code keeps the context so the user can correct it once more.
	await coordinator.submitVerificationCode(syntheticCode);
	t.deepEqual(calls, ['login(2)', 'twoFactorLogin(1)', 'twoFactorLogin(1)']);
});

test('a checkpoint asks for a code only when the user continues', async t => {
	const {client, calls} = scriptedClient({
		loginBySession: {kind: 'checkpoint-required'},
		startChallenge: {kind: 'checkpoint-code-sent', contactPoint: 'phone'},
		sendChallengeCode: {kind: 'unsupported-challenge', step: 'submit_phone'},
	});
	const coordinator = new AuthenticationCoordinator(client);
	t.like(await coordinator.restoreSession({initializeRealtime: false}), {
		kind: 'checkpoint-required',
	});
	t.deepEqual(calls, ['loginBySession(0)']);
	await coordinator.requestCheckpointCode();
	await coordinator.submitVerificationCode(syntheticCode);
	// The unsupported step ends the verification; no further code is accepted.
	t.deepEqual(await coordinator.submitVerificationCode(syntheticCode), {
		kind: 'failed',
		reason: 'invalid-state',
	});
	t.deepEqual(calls, [
		'loginBySession(0)',
		'startChallenge(0)',
		'sendChallengeCode(1)',
	]);
});

test('a throwing client step settles as a typed failure', async t => {
	const coordinator = new AuthenticationCoordinator({
		...scriptedClient({}).client,
		async login() {
			throw new IgNetworkError(new Error('synthetic'));
		},
	});
	t.deepEqual(
		await coordinator.loginWithCredentials('synthetic', syntheticPassword, {
			initializeRealtime: false,
		}),
		{kind: 'network-error'},
	);
	t.deepEqual(coordinator.state, {kind: 'network-error'});
});
