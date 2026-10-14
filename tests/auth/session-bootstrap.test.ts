import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'ava';
import {AuthenticationCoordinator} from '../../source/auth/coordinator.js';
import {InstagramClient} from '../../source/client.js';
import {currentCompatibilityProfile as profile} from '../../source/compatibility/profile.js';
import {ConfigManager} from '../../source/config.js';
import {getLogger} from '../../source/utils/logger.js';
import {forbidNetwork} from '../compatibility/_harness.js';
import {
	ScriptedInstagram,
	ok,
	postLogin,
	savedBytes,
	seedPreviousSession,
	settle,
	step,
	syntheticUserId,
	type ScriptedStep,
} from './_offline-instagram.js';

// A synthetic session id in the browser cookie shape: the account id, `%3A`,
// then an opaque token. It is never a real credential.
const sessionToken = 'AbCdEf0123456789AbCdEf0123456789wxyz';
const browserSession = `${syntheticUserId}%3A${sessionToken}%3A27%3Aabcd-0`;
const resolvedUsername = 'synthetic_account';
const currentUserPath = '/api/v1/accounts/current_user/';

const network = forbidNetwork();
const servers: ScriptedInstagram[] = [];
const clients: InstagramClient[] = [];

test.before(async () => {
	await ConfigManager.getInstance().initialize();
});
test.after.always(t => {
	network.restore();
	t.is(network.attempts, 0);
});
// Shut every client down between tests, so a persisting bootstrap's deferred
// saves flush and detach before the next test reads the users directory.
test.afterEach.always(async () => {
	await Promise.all(clients.map(async client => client.shutdown()));
	clients.length = 0;
	await settle();
});

function scenario() {
	const client = new InstagramClient();
	const server = new ScriptedInstagram(client.getInstagramClient());
	servers.push(server);
	clients.push(client);
	const coordinator = new AuthenticationCoordinator(client);
	return {client, server, coordinator};
}

const currentUser = (
	username: string,
	userId: string = syntheticUserId,
): ScriptedStep =>
	step(
		'GET',
		currentUserPath,
		ok({
			user: {
				pk: Number(userId),
				pk_id: userId,
				username,
				full_name: 'Synthetic Account',
			},
		}),
	);

const failingCurrentUser = (respond: ScriptedStep['respond']): ScriptedStep =>
	step('GET', currentUserPath, respond);

/**
 * Every saved session file and its bytes, so a test can prove a failing
 * bootstrap changed nothing on disk regardless of what earlier tests saved.
 */
async function usersSnapshot(): Promise<string> {
	const usersDirectory = ConfigManager.getInstance().get('advanced.usersDir');
	const files: string[] = [];
	async function walk(directory: string): Promise<void> {
		const entries = await fs
			.readdir(directory, {withFileTypes: true})
			.catch(() => []);

		for (const entry of entries) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				// eslint-disable-next-line no-await-in-loop
				await walk(full);
			} else {
				// eslint-disable-next-line no-await-in-loop
				const bytes = await fs.readFile(full, 'utf8');
				files.push(`${path.relative(usersDirectory, full)}\n${bytes}`);
			}
		}
	}

	await walk(usersDirectory);
	return files.sort().join('\n---\n');
}

test.serial(
	'a validated session is accepted, persisted, and then serves an authenticated read',
	async t => {
		const {client, server, coordinator} = scenario();
		server.expect(currentUser(resolvedUsername), ...postLogin());

		const outcome = await coordinator.bootstrapSession(browserSession, {
			initializeRealtime: false,
		});
		await settle();

		t.deepEqual(outcome, {
			kind: 'session-validated',
			username: resolvedUsername,
		});
		t.deepEqual(server.unexpected, []);
		t.is(server.pending, 0);
		// The validation request named the account and used the private API.
		t.is(server.requestsTo(currentUserPath).length, 1);

		// Persistence happened only after validation, and the saved session
		// carries the imported material under the server-named account.
		const saved = await savedBytes(resolvedUsername);
		t.truthy(saved?.includes(browserSession));
		t.is(
			ConfigManager.getInstance().get('login.currentUsername'),
			resolvedUsername,
		);

		// The bootstrapped client can make a further authenticated private read.
		server.expect(currentUser(resolvedUsername));
		const user = (await client.getInstagramClient().account.currentUser()) as {
			pk: number;
		};
		t.is(String(user.pk), syntheticUserId);
	},
);

test.serial('the validation request presents the 449 profile', async t => {
	const {server, coordinator} = scenario();
	server.expect(currentUser(resolvedUsername), ...postLogin());

	await coordinator.bootstrapSession(browserSession, {
		initializeRealtime: false,
	});
	await settle();

	const [request] = server.requestsTo(currentUserPath);
	t.truthy(request);
	t.is(request!.headers['x-ig-app-id'], profile.appId);
	t.true(request!.headers['user-agent']?.includes(profile.release.appVersion));
});

test.serial(
	'a malformed session id is refused locally, with no request and no file',
	async t => {
		const {server, coordinator} = scenario();
		const before = await usersSnapshot();

		const outcome = await coordinator.bootstrapSession('too-short', {
			initializeRealtime: false,
		});

		t.deepEqual(outcome, {kind: 'no-session', reason: 'unusable'});
		t.deepEqual(server.requests, []);
		t.is(await usersSnapshot(), before);
	},
);

test.serial(
	'a session id without a derivable account id is refused locally',
	async t => {
		const {server, coordinator} = scenario();

		const outcome = await coordinator.bootstrapSession(
			`no-leading-digits%3A${sessionToken}%3A27`,
			{initializeRealtime: false},
		);

		t.deepEqual(outcome, {kind: 'no-session', reason: 'unusable'});
		t.deepEqual(server.requests, []);
	},
);

test.serial(
	'login_required during validation is reported as expiry',
	async t => {
		const {server, coordinator} = scenario();
		const before = await usersSnapshot();
		server.expect(
			failingCurrentUser({
				status: 400,
				body: {status: 'fail', message: 'login_required'},
			}),
		);

		const outcome = await coordinator.bootstrapSession(browserSession, {
			initializeRealtime: false,
		});
		await settle();

		t.deepEqual(outcome, {kind: 'session-expired'});
		t.is(await usersSnapshot(), before);
	},
);

test.serial(
	'a response for a different account is refused and never persisted',
	async t => {
		const {server, coordinator} = scenario();
		const before = await usersSnapshot();
		server.expect(currentUser('someone_else', '9999999'));

		const outcome = await coordinator.bootstrapSession(browserSession, {
			initializeRealtime: false,
		});
		await settle();

		t.deepEqual(outcome, {
			kind: 'incompatible-response',
			reason: 'user-mismatch',
		});
		t.is(await usersSnapshot(), before);
	},
);

test.serial(
	'a 200 response with no account evidence is not treated as success',
	async t => {
		const {server, coordinator} = scenario();
		server.expect(step('GET', currentUserPath, ok({})));

		const outcome = await coordinator.bootstrapSession(browserSession, {
			initializeRealtime: false,
		});
		await settle();

		t.deepEqual(outcome, {
			kind: 'incompatible-response',
			reason: 'missing-user',
		});
	},
);

test.serial('a network failure during validation stops cleanly', async t => {
	const {server, coordinator} = scenario();
	const before = await usersSnapshot();
	server.expect(failingCurrentUser({networkError: 'ECONNRESET'}));

	const outcome = await coordinator.bootstrapSession(browserSession, {
		initializeRealtime: false,
	});
	await settle();

	t.deepEqual(outcome, {kind: 'network-error'});
	t.is(await usersSnapshot(), before);
});

test.serial(
	'a refused certificate during validation is an untrusted connection',
	async t => {
		const {server, coordinator} = scenario();
		const before = await usersSnapshot();
		server.expect(failingCurrentUser({networkError: 'CERT_HAS_EXPIRED'}));

		const outcome = await coordinator.bootstrapSession(browserSession, {
			initializeRealtime: false,
		});
		await settle();

		t.deepEqual(outcome, {
			kind: 'untrusted-connection',
			reason: 'certificate',
		});
		t.is(await usersSnapshot(), before);
	},
);

test.serial(
	'a challenge during validation stops without resolution',
	async t => {
		const {server, coordinator} = scenario();
		const before = await usersSnapshot();
		server.expect(
			failingCurrentUser({
				status: 400,
				body: {
					status: 'fail',
					message: 'challenge_required',
					error_type: 'checkpoint_challenge_required',
					challenge: {api_path: '/challenge/5550001/synthetic-nonce/'},
				},
			}),
		);

		const outcome = await coordinator.bootstrapSession(browserSession, {
			initializeRealtime: false,
		});
		await settle();

		// The bootstrap never drives a challenge; it surfaces it and stops.
		t.deepEqual(outcome, {kind: 'checkpoint-required'});
		t.is(server.pending, 0);
		t.is(await usersSnapshot(), before);
	},
);

test.serial(
	'rate limiting during validation is reported, not retried',
	async t => {
		const {server, coordinator} = scenario();
		const before = await usersSnapshot();
		server.expect(
			failingCurrentUser({
				status: 429,
				body: {status: 'fail', message: 'Please wait a few minutes'},
			}),
		);

		const outcome = await coordinator.bootstrapSession(browserSession, {
			initializeRealtime: false,
		});
		await settle();

		t.deepEqual(outcome, {kind: 'rate-limited'});
		t.is(server.requestsTo(currentUserPath).length, 1);
		t.is(await usersSnapshot(), before);
	},
);

test.serial(
	'a failed bootstrap leaves an unrelated saved session byte-for-byte intact',
	async t => {
		const before = await seedPreviousSession('keeper');
		const {server, coordinator} = scenario();
		server.expect(
			failingCurrentUser({
				status: 400,
				body: {status: 'fail', message: 'login_required'},
			}),
		);

		await coordinator.bootstrapSession(browserSession, {
			initializeRealtime: false,
		});
		await settle();

		t.is(await savedBytes('keeper'), before);
	},
);

test.serial('no session secret reaches the logs', async t => {
	const {server, coordinator} = scenario();
	server.expect(currentUser(resolvedUsername), ...postLogin());

	await coordinator.bootstrapSession(browserSession, {
		initializeRealtime: false,
	});
	await settle();

	const logs = getLogger()
		.getBufferedLogs()
		.map(entry => `${entry.message}\n${entry.stack ?? ''}`)
		.join('\n');
	t.true(logs.length > 0);
	t.false(logs.includes(browserSession));
	t.false(logs.includes(sessionToken));
});
