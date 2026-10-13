import fs from 'node:fs/promises';
import test from 'ava';
import {InstagramClient} from '../../source/client.js';
import {ConfigManager} from '../../source/config.js';
import {SessionManager} from '../../source/session.js';
import {forbidNetwork} from '../compatibility/_harness.js';
import {
	ScriptedInstagram,
	endObservers,
	loginAccepted,
	loginRejected,
	postLogin,
	preLogin,
	seedPreviousSession,
	sessionPath,
	settle,
	step,
	syntheticPassword,
} from './_offline-instagram.js';

const network = forbidNetwork();
test.before(async () => {
	await ConfigManager.getInstance().initialize();
});
test.after.always(t => {
	network.restore();
	t.is(network.attempts, 0);
});

test.serial(
	'a rejected password leaves the previously saved session byte-identical',
	async t => {
		const username = 'overwrite-bad-password';
		const before = await seedPreviousSession(username);
		const client = new InstagramClient();
		const server = new ScriptedInstagram(client.getInstagramClient()).expect(
			...preLogin(),
			loginRejected({error_type: 'bad_password', message: 'synthetic'}),
		);

		const result = await client.login(username, syntheticPassword, {
			initializeRealtime: false,
		});
		await settle();

		t.like(result, {kind: 'invalid-credentials', reason: 'bad-password'});
		t.deepEqual(server.unexpected, []);
		t.is(server.pending, 0);
		t.is(await fs.readFile(sessionPath(username), 'utf8'), before);
	},
);

test.serial(
	'a transport failure during login leaves the previous session intact',
	async t => {
		const username = 'overwrite-interrupted';
		const before = await seedPreviousSession(username);
		const client = new InstagramClient();
		const server = new ScriptedInstagram(client.getInstagramClient()).expect(
			...preLogin(),
			step('POST', '/api/v1/accounts/login/', {networkError: 'ECONNRESET'}),
		);

		const result = await client.login(username, syntheticPassword, {
			initializeRealtime: false,
		});
		await settle();

		t.like(result, {kind: 'network-error'});
		t.deepEqual(server.unexpected, []);
		t.is(await fs.readFile(sessionPath(username), 'utf8'), before);
	},
);

test.serial(
	'an HTTP 200 login without session material is not persisted',
	async t => {
		const username = 'overwrite-empty-200';
		const before = await seedPreviousSession(username);
		const client = new InstagramClient();
		const server = new ScriptedInstagram(client.getInstagramClient()).expect(
			...preLogin(),
			step('POST', '/api/v1/accounts/login/', {
				status: 200,
				body: {status: 'ok'},
			}),
		);

		const result = await client.login(username, syntheticPassword, {
			initializeRealtime: false,
		});
		await settle();

		t.like(result, {kind: 'incompatible-response', reason: 'missing-session'});
		t.deepEqual(server.unexpected, []);
		t.is(await fs.readFile(sessionPath(username), 'utf8'), before);
	},
);

test.serial(
	'repeated login attempts do not accumulate persistence subscriptions',
	async t => {
		const username = 'overwrite-repeated';
		await seedPreviousSession(username);
		const client = new InstagramClient();
		const server = new ScriptedInstagram(client.getInstagramClient());
		const baseline = endObservers(client);
		server.expect(
			...preLogin(),
			loginRejected({error_type: 'bad_password', message: 'synthetic'}),
		);
		await client.login(username, syntheticPassword, {
			initializeRealtime: false,
		});
		// The pre-login flow runs once per client; the encryption key is kept.
		server.expect(
			loginRejected({error_type: 'bad_password', message: 'synthetic'}),
		);
		await client.login(username, syntheticPassword, {
			initializeRealtime: false,
		});
		server.expect(loginAccepted(username), ...postLogin());
		await client.login(username, syntheticPassword, {
			initializeRealtime: false,
		});
		await settle();

		t.deepEqual(server.unexpected, []);
		t.is(server.pending, 0);
		t.true(endObservers(client) <= baseline + 1);
		await client.logout(username);
		t.is(endObservers(client), baseline);
	},
);

test.serial(
	'restoring a session the server has ended does not rewrite it',
	async t => {
		const username = 'overwrite-restore-expired';
		const before = await seedPreviousSession(username);
		const client = new InstagramClient(username);
		const server = new ScriptedInstagram(client.getInstagramClient()).expect(
			step('POST', '/api/v1/feed/reels_tray/', {
				status: 403,
				body: {status: 'fail', message: 'login_required'},
				headers: {
					'set-cookie': ['sessionid=""; Domain=.instagram.com; Path=/'],
				},
			}),
		);

		await client.loginBySession({initializeRealtime: false});
		await settle();

		t.deepEqual(server.unexpected, []);
		t.is(server.pending, 0);
		t.is(await fs.readFile(sessionPath(username), 'utf8'), before);
	},
);

test.serial(
	'restoring a session while offline does not rewrite it',
	async t => {
		const username = 'overwrite-restore-offline';
		const before = await seedPreviousSession(username);
		const client = new InstagramClient(username);
		const server = new ScriptedInstagram(client.getInstagramClient()).expect(
			step('POST', '/api/v1/feed/reels_tray/', {networkError: 'ENETUNREACH'}),
		);

		await client.loginBySession({initializeRealtime: false});
		await settle();

		t.deepEqual(server.unexpected, []);
		t.is(await fs.readFile(sessionPath(username), 'utf8'), before);
	},
);

test.serial(
	'a successful credential login replaces the session but keeps its identity',
	async t => {
		const username = 'overwrite-success';
		await seedPreviousSession(username);
		const previous = await new SessionManager(username).loadSession();
		const client = new InstagramClient();
		const server = new ScriptedInstagram(client.getInstagramClient()).expect(
			...preLogin(),
			loginAccepted(username),
			...postLogin(),
		);

		const result = await client.login(username, syntheticPassword, {
			initializeRealtime: false,
		});
		await client.shutdown();

		t.like(result, {
			kind: 'authenticated',
			via: 'credentials',
			persisted: true,
		});
		t.deepEqual(server.unexpected, []);
		const saved = await new SessionManager(username).loadSession();
		for (const field of ['deviceId', 'uuid', 'phoneId', 'adid', 'build']) {
			t.is(saved?.[field], previous?.[field], `${field} is kept`);
		}

		t.true(String(saved?.['cookies']).includes('synthetic-sessionid-a1b2c3'));
		t.false(JSON.stringify(saved).includes(syntheticPassword));
	},
);
