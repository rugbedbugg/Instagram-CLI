import test from 'ava';
import {AuthenticationCoordinator} from '../../source/auth/coordinator.js';
import {describeAuthenticationOutcome} from '../../source/auth/outcomes.js';
import {InstagramClient} from '../../source/client.js';
import {currentCompatibilityProfile as profile} from '../../source/compatibility/profile.js';
import {ConfigManager} from '../../source/config.js';
import {SessionManager} from '../../source/session.js';
import {getLogger} from '../../source/utils/logger.js';
import {forbidNetwork} from '../compatibility/_harness.js';
import {
	ScriptedInstagram,
	endObservers,
	loggedInUser,
	loginAccepted,
	loginRejected,
	ok,
	postLogin,
	preLogin,
	previousSessionId,
	savedBytes,
	seedPreviousSession,
	sessionCookies,
	settle,
	signedPayload,
	step,
	syntheticCode,
	syntheticPassword,
	syntheticSessionId,
	syntheticTwoFactorIdentifier,
	syntheticUserId,
} from './_offline-instagram.js';

const network = forbidNetwork();
const servers: ScriptedInstagram[] = [];
const outcomeObjects: string[] = [];
const outcomeMessages: string[] = [];

test.before(async () => {
	await ConfigManager.getInstance().initialize();
});
test.after.always(t => {
	network.restore();
	t.is(network.attempts, 0);
});

function scenario(username?: string) {
	const client = new InstagramClient(username);
	const server = new ScriptedInstagram(client.getInstagramClient());
	servers.push(server);
	const coordinator = new AuthenticationCoordinator(client);
	return {client, server, coordinator};
}

function record<T extends Parameters<typeof describeAuthenticationOutcome>[0]>(
	outcome: T,
): T {
	outcomeObjects.push(JSON.stringify(outcome));
	outcomeMessages.push(describeAuthenticationOutcome(outcome));
	return outcome;
}

const credentials = {initializeRealtime: false};
const challengePath = `/challenge/${syntheticUserId}/synthetic-nonce/`;
const checkpointRequired = loginRejected({
	message: 'challenge_required',
	error_type: 'checkpoint_challenge_required',
	challenge: {api_path: challengePath},
});
const twoFactorRequired = loginRejected({
	message: '',
	two_factor_required: true,
	two_factor_info: {
		two_factor_identifier: syntheticTwoFactorIdentifier,
		totp_two_factor_on: true,
	},
});

test.serial(
	'success: the full credential flow authenticates, saves once established, and sends the 449 profile',
	async t => {
		const username = 'lifecycle-success';
		const {client, server, coordinator} = scenario();
		server.expect(...preLogin(), loginAccepted(username), ...postLogin());

		const outcome = record(
			await coordinator.loginWithCredentials(
				username,
				syntheticPassword,
				credentials,
			),
		);
		await client.shutdown();

		t.deepEqual(outcome, {
			kind: 'authenticated',
			username,
			via: 'credentials',
			persisted: true,
		});
		t.deepEqual(coordinator.state, outcome);
		t.deepEqual(server.unexpected, []);
		t.deepEqual(
			server.requests.map(request => `${request.method} ${request.path}`),
			[
				'POST /api/v1/launcher/sync/',
				'POST /api/v1/qe/sync/',
				'POST /api/v1/accounts/login/',
				'POST /api/v1/feed/reels_tray/',
				'POST /api/v1/feed/timeline/',
			],
		);
		t.is(ConfigManager.getInstance().get('login.currentUsername'), username);
		const saved = await savedBytes(username);
		t.true(saved?.includes(syntheticSessionId));
	},
);

test.serial(
	'invalid credentials: one submission, a typed outcome and no retry',
	async t => {
		const username = 'lifecycle-invalid-user';
		const before = await seedPreviousSession(username);
		const {server, coordinator} = scenario();
		server.expect(
			...preLogin(),
			loginRejected({error_type: 'invalid_user', message: 'synthetic'}),
		);

		const outcome = record(
			await coordinator.loginWithCredentials(
				username,
				syntheticPassword,
				credentials,
			),
		);
		await settle();

		t.deepEqual(outcome, {kind: 'invalid-credentials', reason: 'invalid-user'});
		t.is(server.requestsTo('/api/v1/accounts/login/').length, 1);
		t.is(await savedBytes(username), before);
	},
);

test.serial(
	'two-factor: nothing persists until the single code submission succeeds',
	async t => {
		const username = 'lifecycle-two-factor';
		const before = await seedPreviousSession(username);
		const {client, server, coordinator} = scenario();
		server.expect(...preLogin(), twoFactorRequired);

		const required = record(
			await coordinator.loginWithCredentials(
				username,
				syntheticPassword,
				credentials,
			),
		);
		await settle();
		t.deepEqual(required, {
			kind: 'two-factor-required',
			challenge: {identifier: syntheticTwoFactorIdentifier, method: 'totp'},
		});
		t.is(await savedBytes(username), before);

		server.expect(
			step(
				'POST',
				'/api/v1/accounts/two_factor_login/',
				ok(
					{logged_in_user: loggedInUser(username)},
					{'set-cookie': sessionCookies()},
				),
			),
			...postLogin(),
		);
		const outcome = record(
			await coordinator.submitVerificationCode(syntheticCode),
		);
		await client.shutdown();

		t.like(outcome, {
			kind: 'authenticated',
			via: 'two-factor',
			persisted: true,
		});
		t.deepEqual(server.unexpected, []);
		const submissions = server.requestsTo('/api/v1/accounts/two_factor_login/');
		t.is(submissions.length, 1);
		t.like(signedPayload(submissions[0]!.body), {
			verification_code: syntheticCode,
			two_factor_identifier: syntheticTwoFactorIdentifier,
			verification_method: '0',
		});
		const saved = await savedBytes(username);
		t.true(saved?.includes(syntheticSessionId));
		t.false(saved?.includes(syntheticCode));
		t.false(saved?.includes(syntheticTwoFactorIdentifier));
	},
);

test.serial(
	'two-factor: a rejected code is a typed failure, not resent or persisted',
	async t => {
		const username = 'lifecycle-two-factor-rejected';
		const before = await seedPreviousSession(username);
		const {server, coordinator} = scenario();
		server.expect(...preLogin(), twoFactorRequired);
		await coordinator.loginWithCredentials(
			username,
			syntheticPassword,
			credentials,
		);
		server.expect(
			step('POST', '/api/v1/accounts/two_factor_login/', {
				status: 400,
				body: {status: 'fail', message: 'synthetic invalid code'},
			}),
		);

		const outcome = record(
			await coordinator.submitVerificationCode(syntheticCode),
		);
		await settle();

		t.deepEqual(outcome, {
			kind: 'failed',
			reason: 'unexpected-error',
			status: 400,
		});
		t.is(server.requestsTo('/api/v1/accounts/two_factor_login/').length, 1);
		t.is(server.pending, 0);
		t.is(await savedBytes(username), before);
	},
);

test.serial(
	'checkpoint: an evidenced email-code challenge completes through the existing flow',
	async t => {
		const username = 'lifecycle-checkpoint';
		const {client, server, coordinator} = scenario();
		server.expect(...preLogin(), checkpointRequired);
		t.deepEqual(
			record(
				await coordinator.loginWithCredentials(
					username,
					syntheticPassword,
					credentials,
				),
			),
			{kind: 'checkpoint-required'},
		);

		server.expect(
			step(
				'POST',
				`/api/v1/challenge/reset/${syntheticUserId}/synthetic-nonce/`,
				ok({
					step_name: 'select_verify_method',
					step_data: {choice: '1', email: 's****@example.invalid'},
				}),
			),
			step(
				'POST',
				`/api/v1${challengePath}`,
				ok({step_name: 'verify_email', step_data: {}}),
			),
		);
		t.deepEqual(record(await coordinator.requestCheckpointCode()), {
			kind: 'checkpoint-code-sent',
			contactPoint: 'email',
		});

		server.expect(
			step(
				'POST',
				`/api/v1${challengePath}`,
				ok(
					{action: 'close', logged_in_user: loggedInUser(username)},
					{'set-cookie': sessionCookies()},
				),
			),
			...postLogin(),
		);
		const outcome = record(
			await coordinator.submitVerificationCode(syntheticCode),
		);
		await client.shutdown();

		t.like(outcome, {kind: 'authenticated', via: 'challenge', persisted: true});
		t.deepEqual(server.unexpected, []);
		t.is(server.pending, 0);
		t.like(signedPayload(server.requests.at(-3)!.body), {
			security_code: syntheticCode,
		});
	},
);

test.serial(
	'checkpoint: an unsupported challenge step stops without guessing or persisting',
	async t => {
		const username = 'lifecycle-unsupported-checkpoint';
		const before = await seedPreviousSession(username);
		const {server, coordinator} = scenario();
		server.expect(...preLogin(), checkpointRequired);
		await coordinator.loginWithCredentials(
			username,
			syntheticPassword,
			credentials,
		);
		server.expect(
			step(
				'POST',
				`/api/v1/challenge/reset/${syntheticUserId}/synthetic-nonce/`,
				ok({step_name: 'submit_phone', step_data: {}}),
			),
		);

		const outcome = record(await coordinator.requestCheckpointCode());
		await settle();

		t.deepEqual(outcome, {kind: 'unsupported-challenge', step: 'submit_phone'});
		t.deepEqual(await coordinator.submitVerificationCode(syntheticCode), {
			kind: 'failed',
			reason: 'invalid-state',
		});
		t.deepEqual(server.unexpected, []);
		t.is(server.pending, 0);
		t.is(await savedBytes(username), before);
	},
);

test.serial(
	'rate limiting: a throttled login is reported once and never retried',
	async t => {
		const username = 'lifecycle-rate-limited';
		const before = await seedPreviousSession(username);
		const {server, coordinator} = scenario();
		server.expect(
			...preLogin(),
			loginRejected(
				{message: 'Please wait a few minutes before you try again.'},
				429,
			),
		);

		const outcome = record(
			await coordinator.loginWithCredentials(
				username,
				syntheticPassword,
				credentials,
			),
		);
		await settle();

		t.deepEqual(outcome, {kind: 'rate-limited'});
		t.is(server.requestsTo('/api/v1/accounts/login/').length, 1);
		t.is(server.pending, 0);
		t.is(await savedBytes(username), before);
	},
);

test.serial(
	'malformed response: an unparseable login body is incompatible, not success',
	async t => {
		const username = 'lifecycle-malformed';
		const before = await seedPreviousSession(username);
		const {server, coordinator} = scenario();
		server.expect(
			...preLogin(),
			step('POST', '/api/v1/accounts/login/', {
				status: 200,
				body: '<html>not the private API</html>',
				headers: {'set-cookie': sessionCookies()},
			}),
		);

		const outcome = record(
			await coordinator.loginWithCredentials(
				username,
				syntheticPassword,
				credentials,
			),
		);
		await settle();

		t.deepEqual(outcome, {
			kind: 'incompatible-response',
			reason: 'malformed-response',
		});
		t.is(await savedBytes(username), before);
	},
);

test.serial(
	'unexpected authorization: a session for another account is rejected',
	async t => {
		const username = 'lifecycle-user-mismatch';
		const before = await seedPreviousSession(username);
		const {server, coordinator} = scenario();
		server.expect(
			...preLogin(),
			step(
				'POST',
				'/api/v1/accounts/login/',
				ok(
					{logged_in_user: {...loggedInUser(username), pk: 999}},
					{'set-cookie': sessionCookies()},
				),
			),
		);

		const outcome = record(
			await coordinator.loginWithCredentials(
				username,
				syntheticPassword,
				credentials,
			),
		);
		await settle();

		t.deepEqual(outcome, {
			kind: 'incompatible-response',
			reason: 'user-mismatch',
		});
		t.is(await savedBytes(username), before);
	},
);

const withSessionCookies = (
	status: number,
	body: unknown,
): {status: number; body: unknown; headers: Record<string, string[]>} => ({
	status,
	body,
	headers: {'set-cookie': sessionCookies()},
});

for (const [index, [name, response, expected]] of (
	[
		[
			'an HTTP 200 without status',
			withSessionCookies(200, {}),
			{kind: 'incompatible-response', reason: 'malformed-response'},
		],
		[
			'an accepted status without the logged-in user',
			withSessionCookies(200, {status: 'ok'}),
			{kind: 'incompatible-response', reason: 'missing-user'},
		],
		[
			'a rejected password',
			withSessionCookies(400, {status: 'fail', error_type: 'bad_password'}),
			{kind: 'invalid-credentials', reason: 'bad-password'},
		],
	] as const
).entries()) {
	test.serial(
		`evidence: session cookies with ${name} do not authenticate a login`,
		async t => {
			const username = `lifecycle-evidence-login-${index}`;
			const before = await seedPreviousSession(username);
			const {client, server, coordinator} = scenario();
			const baseline = endObservers(client);
			server.expect(
				...preLogin(),
				step('POST', '/api/v1/accounts/login/', response),
			);

			const outcome = record(
				await coordinator.loginWithCredentials(
					username,
					syntheticPassword,
					credentials,
				),
			);
			await settle();

			t.like(outcome, expected);
			t.deepEqual(server.unexpected, []);
			t.is(server.pending, 0);
			t.is(endObservers(client), baseline);
			t.is(await savedBytes(username), before);
		},
	);
}

test.serial(
	'evidence: session cookies on a failed two-factor response do not authenticate',
	async t => {
		const username = 'lifecycle-evidence-two-factor';
		const before = await seedPreviousSession(username);
		const {client, server, coordinator} = scenario();
		const baseline = endObservers(client);
		server.expect(...preLogin(), twoFactorRequired);
		await coordinator.loginWithCredentials(
			username,
			syntheticPassword,
			credentials,
		);
		server.expect(
			step(
				'POST',
				'/api/v1/accounts/two_factor_login/',
				withSessionCookies(200, {status: 'fail'}),
			),
		);

		const outcome = record(
			await coordinator.submitVerificationCode(syntheticCode),
		);
		await settle();

		t.like(outcome, {
			kind: 'incompatible-response',
			reason: 'malformed-response',
		});
		t.is(server.pending, 0);
		t.is(endObservers(client), baseline);
		t.is(await savedBytes(username), before);
	},
);

test.serial(
	'evidence: session cookies without a closed challenge do not authenticate',
	async t => {
		const username = 'lifecycle-evidence-challenge';
		const before = await seedPreviousSession(username);
		const {client, server, coordinator} = scenario();
		const baseline = endObservers(client);
		server.expect(
			...preLogin(),
			checkpointRequired,
			step(
				'POST',
				`/api/v1/challenge/reset/${syntheticUserId}/synthetic-nonce/`,
				ok({step_name: 'verify_email', step_data: {}}),
			),
		);
		await coordinator.loginWithCredentials(
			username,
			syntheticPassword,
			credentials,
		);
		t.like(await coordinator.requestCheckpointCode(), {
			kind: 'checkpoint-code-sent',
		});
		server.expect(
			step(
				'POST',
				`/api/v1${challengePath}`,
				withSessionCookies(200, {
					status: 'ok',
					step_name: 'verify_email',
					step_data: {},
				}),
			),
		);

		const outcome = record(
			await coordinator.submitVerificationCode(syntheticCode),
		);
		await settle();

		t.like(outcome, {kind: 'unsupported-challenge', step: 'verify_email'});
		t.deepEqual(server.unexpected, []);
		t.is(server.pending, 0);
		t.is(endObservers(client), baseline);
		t.is(await savedBytes(username), before);
	},
);

test.serial(
	'session save failure: authentication succeeds but reports the session as unsaved',
	async t => {
		const username = 'lifecycle-save-failure';
		const before = await seedPreviousSession(username);
		const {client, server, coordinator} = scenario();
		// A state field JSON cannot serialize makes every save fail before I/O.
		Object.assign(client.getInstagramClient().state, {unserializable: 1n});
		server.expect(...preLogin(), loginAccepted(username), ...postLogin());

		const outcome = record(
			await coordinator.loginWithCredentials(
				username,
				syntheticPassword,
				credentials,
			),
		);
		await client.shutdown();

		t.like(outcome, {kind: 'authenticated', persisted: false});
		t.is(await savedBytes(username), before);
	},
);

test.serial(
	'restore without validation: an unreachable server leaves the session unverified and untouched',
	async t => {
		const username = 'lifecycle-restore-unverified';
		const before = await seedPreviousSession(username);
		const {client, server, coordinator} = scenario(username);
		server.expect(
			step('POST', '/api/v1/feed/reels_tray/', {networkError: 'ETIMEDOUT'}),
		);

		const outcome = record(
			await coordinator.restoreSession({initializeRealtime: false}),
		);
		await client.shutdown();

		t.deepEqual(outcome, {kind: 'session-restored-unverified', username});
		t.deepEqual(server.unexpected, []);
		t.is(server.pending, 0);
		t.is(await savedBytes(username), before);
	},
);

test.serial(
	'expired session: a rejected restore is reported and the file is kept',
	async t => {
		const username = 'lifecycle-restore-expired';
		const before = await seedPreviousSession(username);
		const {client, server, coordinator} = scenario(username);
		const baseline = endObservers(client);
		server.expect(
			step('POST', '/api/v1/feed/reels_tray/', {
				status: 403,
				body: {status: 'fail', message: 'login_required'},
			}),
		);

		const outcome = record(
			await coordinator.restoreSession({initializeRealtime: false}),
		);
		await settle();

		t.deepEqual(outcome, {kind: 'session-expired'});
		t.is(endObservers(client), baseline);
		t.is(await savedBytes(username), before);
	},
);

test.serial(
	'expired mid-session: persistence stops when the server ends a validated session',
	async t => {
		const username = 'lifecycle-expired-later';
		await seedPreviousSession(username);
		const {client, server, coordinator} = scenario(username);
		const baseline = endObservers(client);
		server.expect(
			step('POST', '/api/v1/feed/reels_tray/', ok({tray: []})),
			step('POST', '/api/v1/feed/timeline/', ok({feed_items: []})),
		);
		t.deepEqual(
			record(await coordinator.restoreSession({initializeRealtime: false})),
			{kind: 'session-validated', username},
		);
		await settle();
		const validated = await savedBytes(username);
		t.true(validated?.includes(previousSessionId));
		t.true(endObservers(client) > baseline);

		server.expect(
			step('POST', '/api/v1/feed/timeline/', {
				status: 403,
				body: {status: 'fail', message: 'login_required'},
				headers: {
					'set-cookie': ['sessionid=""; Domain=.instagram.com; Path=/'],
				},
			}),
		);
		await t.throwsAsync(client.getInstagramClient().feed.timeline().request());
		await settle();

		t.is(endObservers(client), baseline);
		t.is(await savedBytes(username), validated);
	},
);

test.serial(
	'logout then login: no pending write resurrects the session; the next login saves anew',
	async t => {
		const username = 'lifecycle-logout';
		const {client, server, coordinator} = scenario();
		const baseline = endObservers(client);
		server.expect(...preLogin(), loginAccepted(username), ...postLogin());
		await coordinator.loginWithCredentials(
			username,
			syntheticPassword,
			credentials,
		);

		await client.logout(username);
		await settle();
		t.is(await savedBytes(username), undefined);
		t.is(endObservers(client), baseline);
		t.false(await new SessionManager(username).sessionExists());

		// The pre- and post-login flows already ran for this client.
		server.expect(loginAccepted(username));
		const again = record(
			await coordinator.loginWithCredentials(
				username,
				syntheticPassword,
				credentials,
			),
		);
		await client.shutdown();

		t.like(again, {kind: 'authenticated', persisted: true});
		t.deepEqual(server.unexpected, []);
		t.is(server.pending, 0);
		const saved = await savedBytes(username);
		t.true(saved?.includes(syntheticSessionId));
		t.is(endObservers(client), baseline);
	},
);

test.serial('every scripted request carried the selected 449 profile', t => {
	const requests = servers.flatMap(server => server.requests);
	t.true(requests.length > 30);
	for (const request of requests) {
		t.true(
			request.headers['user-agent']?.startsWith(
				`Instagram ${profile.release.appVersion} Android`,
			),
		);
		t.is(request.headers['x-bloks-version-id'], profile.release.bloksVersionId);
		t.is(request.headers['x-ig-app-id'], profile.appId);
	}
});

test.serial('secrets never reach logs, outcomes or user-facing text', t => {
	const logs = getLogger()
		.getBufferedLogs()
		.map(entry => `${entry.message}\n${entry.stack ?? ''}`)
		.join('\n');
	t.true(logs.length > 0);
	const credentialsAndTokens = [
		syntheticPassword,
		syntheticCode,
		syntheticSessionId,
		previousSessionId,
		'synthetic-csrf',
	];
	const surfaces: Array<[string, string, string[]]> = [
		['logs', logs, [...credentialsAndTokens, syntheticTwoFactorIdentifier]],
		[
			'messages',
			outcomeMessages.join('\n'),
			[...credentialsAndTokens, syntheticTwoFactorIdentifier],
		],
		// The 2FA identifier is the transient context the coordinator holds.
		['outcomes', outcomeObjects.join('\n'), credentialsAndTokens],
	];
	for (const [surface, text, secrets] of surfaces) {
		for (const secret of secrets) {
			t.false(text.includes(secret), `${secret} leaked into ${surface}`);
		}
	}
});
