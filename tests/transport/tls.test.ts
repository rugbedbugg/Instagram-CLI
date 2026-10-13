import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import process from 'node:process';
import test, {type ExecutionContext} from 'ava';
import {IgNetworkError} from 'instagram-private-api';
import {classifyAuthenticationError} from '../../source/auth/outcomes.js';
import {InstagramClient} from '../../source/client.js';
import {createInstagramApiClient} from '../../source/compatibility/client.js';
import {ConfigManager} from '../../source/config.js';
import {
	InsecureTransportError,
	assertTransportTrust,
	restTransportModule,
} from '../../source/security/transport-trust.js';
import {getLogger, initializeLogger} from '../../source/utils/logger.js';
import {
	endObservers,
	seedPreviousSession,
	sessionPath,
	syntheticPassword,
} from '../auth/_offline-instagram.js';
import {
	allowLoopbackOnly,
	recordTlsOptions,
	startConnectProxy,
	startTlsServer,
	testCertificateAuthority,
	type CertificateName,
} from './_loopback.js';

const guard = allowLoopbackOnly();
const handshakes = recordTlsOptions();

test.before(async () => {
	await ConfigManager.getInstance().initialize();
	await initializeLogger();
});
test.after.always(t => {
	handshakes.restore();
	guard.restore();
	t.deepEqual(guard.denied, []);
});

type Trust = {readonly trustTestRoot?: boolean};

/** A production client whose requests go to a loopback endpoint. */
function client({trustTestRoot = false}: Trust = {}) {
	const ig = createInstagramApiClient();
	if (trustTestRoot) {
		// Not an override of verification: an additional trusted root, as
		// NODE_EXTRA_CA_CERTS would add one.
		ig.request.defaults = {ca: testCertificateAuthority()};
	}

	return ig;
}

async function probe(ig: ReturnType<typeof client>, port: number) {
	return ig.request.send({
		url: '/api/v1/tls-probe/',
		baseUrl: `https://localhost:${port}/`,
		// The dependency names i.instagram.com in Host, which TLS verifies.
		headers: {Host: 'localhost'},
	});
}

async function refused(t: ExecutionContext, attempt: Promise<unknown>) {
	const error = await t.throwsAsync(attempt, {instanceOf: IgNetworkError});
	return classifyAuthenticationError(error);
}

test.serial(
	'the installed transport and its patch no longer disable verification',
	async t => {
		const require = createRequire(import.meta.url);
		const installed = await fs.readFile(
			require.resolve(restTransportModule),
			'utf8',
		);
		t.notRegex(installed, /strictSSL\s*:\s*false/);
		t.notRegex(installed, /rejectUnauthorized\s*:\s*false/);
		t.regex(installed, /assertHostMatchesUrl\(options\)/);

		const patch = await fs.readFile(
			path.join('patches', 'instagram-private-api+1.46.1.patch'),
			'utf8',
		);
		t.regex(patch, /^-\s+strictSSL: false,$/m);
		t.regex(patch, /^\+\s+Request\.assertHostMatchesUrl\(options\);$/m);
		t.notThrows(() => {
			assertTransportTrust();
		});
	},
);

test.serial(
	'a trusted certificate is accepted with verification on at the TLS boundary',
	async t => {
		const server = await startTlsServer('localhost', guard);
		const before = handshakes.seen.length;
		try {
			const response = await probe(client({trustTestRoot: true}), server.port);
			t.like(response.body, {status: 'ok'});
			t.deepEqual(server.requests, ['GET /api/v1/tls-probe/']);
		} finally {
			await server.close();
		}

		const options = handshakes.seen.slice(before);
		t.true(options.length > 0);
		for (const option of options) {
			t.not(option.rejectUnauthorized, false);
			t.is(option.servername, 'localhost');
		}
	},
);

for (const [name, certificate, trustTestRoot, reason] of [
	['a self-signed certificate', 'self-signed', true, 'certificate'],
	[
		'a certificate from an untrusted authority',
		'localhost',
		false,
		'certificate',
	],
	['a trusted certificate naming another host', 'wrong-host', true, 'hostname'],
] as Array<[string, CertificateName, boolean, string]>) {
	test.serial(`${name} is refused before any request is sent`, async t => {
		const server = await startTlsServer(certificate, guard);
		try {
			const outcome = await refused(
				t,
				probe(client({trustTestRoot}), server.port),
			);
			t.deepEqual(outcome, {kind: 'untrusted-connection', reason});
			t.deepEqual(server.requests, []);
		} finally {
			await server.close();
		}
	});
}

test.serial(
	'through a CONNECT proxy, the tunnelled connection is verified end to end',
	async t => {
		const server = await startTlsServer('localhost', guard);
		const proxy = await startConnectProxy(server.port, guard);
		const before = handshakes.seen.length;
		try {
			const ig = client({trustTestRoot: true});
			ig.state.proxyUrl = `http://127.0.0.1:${proxy.port}`;
			const response = await probe(ig, server.port);
			t.like(response.body, {status: 'ok'});
			t.deepEqual(proxy.authorities, [`localhost:${server.port}`]);
		} finally {
			await proxy.close();
			await server.close();
		}

		const options = handshakes.seen.slice(before);
		t.true(options.length > 0);
		for (const option of options) {
			t.not(option.rejectUnauthorized, false);
			t.is(option.servername, 'localhost');
		}
	},
);

for (const [name, certificate, reason] of [
	['a self-signed certificate', 'self-signed', 'certificate'],
	['a trusted certificate naming another host', 'wrong-host', 'hostname'],
] as Array<[string, CertificateName, string]>) {
	test.serial(`through a CONNECT proxy, ${name} is refused`, async t => {
		const server = await startTlsServer(certificate, guard);
		const proxy = await startConnectProxy(server.port, guard);
		try {
			const ig = client({trustTestRoot: true});
			ig.state.proxyUrl = `http://127.0.0.1:${proxy.port}`;
			const outcome = await refused(t, probe(ig, server.port));
			t.deepEqual(outcome, {kind: 'untrusted-connection', reason});
			t.deepEqual(server.requests, []);
		} finally {
			await proxy.close();
			await server.close();
		}
	});
}

test.serial(
	'an HTTPS proxy with an untrusted certificate is refused',
	async t => {
		const server = await startTlsServer('localhost', guard);
		const proxy = await startConnectProxy(server.port, guard, 'self-signed');
		try {
			const ig = client({trustTestRoot: true});
			ig.state.proxyUrl = `https://localhost:${proxy.port}`;
			const error = await t.throwsAsync(probe(ig, server.port), {
				instanceOf: IgNetworkError,
			});
			// tunnel-agent keeps only the cause's text, so this is reported as a
			// network failure; the handshake with the proxy was still refused.
			t.regex(error?.message ?? '', /cause=self-signed certificate/);
			t.deepEqual(classifyAuthenticationError(error), {kind: 'network-error'});
			t.deepEqual(proxy.authorities, []);
			t.deepEqual(server.requests, []);
		} finally {
			await proxy.close();
			await server.close();
		}
	},
);

test.serial(
	'a login through an intercepting proxy stops before any credential is sent',
	async t => {
		const username = 'tls-intercepted-login';
		const before = await seedPreviousSession(username);
		// The proxy answers every tunnel, including i.instagram.com:443, with a
		// certificate the test root trusts but that names localhost.
		const server = await startTlsServer('localhost', guard);
		const proxy = await startConnectProxy(server.port, guard);
		const instagram = new InstagramClient();
		const ig = instagram.getInstagramClient();
		const baseline = endObservers(instagram);
		ig.request.defaults = {ca: testCertificateAuthority()};
		ig.state.proxyUrl = `http://127.0.0.1:${proxy.port}`;
		try {
			const outcome = await instagram.login(username, syntheticPassword, {
				initializeRealtime: false,
			});
			t.deepEqual(outcome, {kind: 'untrusted-connection', reason: 'hostname'});
			t.true(proxy.authorities.length > 0);
			t.true(
				proxy.authorities.every(
					authority => authority === 'i.instagram.com:443',
				),
			);
			t.deepEqual(server.requests, []);
			t.is(endObservers(instagram), baseline);
			t.is(await fs.readFile(sessionPath(username), 'utf8'), before);
		} finally {
			await proxy.close();
			await server.close();
		}

		await getLogger().flush();
		const log = await fs.readFile(getLogger().getLogFilePath(), 'utf8');
		t.regex(log, /Login ended with untrusted-connection/);
		t.false(log.includes(syntheticPassword));
	},
);

for (const viaProxy of [false, true]) {
	test.serial(
		`${viaProxy ? 'through a CONNECT proxy, ' : ''}a Host header naming another host is refused before connecting`,
		async t => {
			// The peer holds a trusted certificate for the Host name only. Node
			// would send that name as SNI and verify the certificate against it.
			const server = await startTlsServer('wrong-host', guard);
			const proxy = viaProxy
				? await startConnectProxy(server.port, guard)
				: undefined;
			const before = handshakes.seen.length;
			try {
				const ig = client({trustTestRoot: true});
				if (proxy) {
					ig.state.proxyUrl = `http://127.0.0.1:${proxy.port}`;
				}

				await t.throwsAsync(
					ig.request.send({
						url: '/api/v1/tls-probe/',
						baseUrl: `https://localhost:${server.port}/`,
						headers: {Host: 'wrong-host.invalid'},
					}),
					{message: /Host header does not name the request URL's host/},
				);
				t.is(handshakes.seen.length, before);
				t.deepEqual(server.requests, []);
				t.deepEqual(proxy?.authorities ?? [], []);
			} finally {
				await proxy?.close();
				await server.close();
			}
		},
	);
}

test.serial(
	'a second Host spelling cannot shadow the default Host header',
	async t => {
		const server = await startTlsServer('localhost', guard);
		const before = handshakes.seen.length;
		try {
			// Merged options keep the dependency's `Host: i.instagram.com` beside
			// this lowercase `host`; Node would verify against the former.
			await t.throwsAsync(
				client({trustTestRoot: true}).request.send({
					url: '/api/v1/tls-probe/',
					baseUrl: `https://localhost:${server.port}/`,
					headers: {host: 'localhost'},
				}),
				{message: /Host header does not name the request URL's host/},
			);
			t.is(handshakes.seen.length, before);
			t.deepEqual(server.requests, []);
		} finally {
			await server.close();
		}
	},
);

test.serial(
	'a Host header naming the URL host is accepted in any form',
	async t => {
		const server = await startTlsServer('localhost', guard);
		try {
			const response = await client({trustTestRoot: true}).request.send({
				url: '/api/v1/tls-probe/',
				baseUrl: `https://localhost:${server.port}/`,
				headers: {Host: `LOCALHOST:${server.port}`},
			});
			t.like(response.body, {status: 'ok'});
		} finally {
			await server.close();
		}
	},
);

test.serial(
	'production requests always name their URL host in the Host header',
	async t => {
		const seen: Array<{host: string; header: string}> = [];
		const recorder = {
			request(options: {host: string; headers: Record<string, string>}) {
				const header = Object.entries(options.headers).find(
					([name]) => name.toLowerCase() === 'host',
				);
				seen.push({host: options.host, header: header?.[1] ?? ''});
				// The request library drives its transport through EventEmitter.
				// eslint-disable-next-line unicorn/prefer-event-target
				const request = Object.assign(new EventEmitter(), {
					setTimeout: () => request,
					write: () => true,
					end() {
						setImmediate(() => request.emit('error', new Error('recorded')));
					},
					abort() {},
					destroy() {},
				});
				return request;
			},
		};
		const ig = createInstagramApiClient();
		ig.state.generateDevice('host-binding');
		const recordingDefaults = {
			httpModules: {'https:': recorder, 'http:': recorder},
			pool: false as const,
		};
		ig.request.defaults = recordingDefaults;
		await t.throwsAsync(ig.qe.syncLoginExperiments());
		await t.throwsAsync(ig.feed.timeline().request());
		await t.throwsAsync(ig.launcher.preLoginSync());
		await t.throwsAsync(ig.user.info('1'));
		await t.throwsAsync(ig.feed.directInbox().request());

		t.is(seen.length, 5);
		for (const {host, header} of seen) {
			t.is(host, 'i.instagram.com');
			t.is(header, host);
		}
	},
);

test.serial('verification bypasses are refused before a client exists', t => {
	t.throws(
		() => {
			assertTransportTrust({
				environment: {NODE_TLS_REJECT_UNAUTHORIZED: '0'},
			});
		},
		{instanceOf: InsecureTransportError, message: /NODE_EXTRA_CA_CERTS/},
	);
	t.notThrows(() => {
		assertTransportTrust({environment: {NODE_TLS_REJECT_UNAUTHORIZED: '1'}});
	});

	const unpatched = t.throws(
		() => {
			assertTransportTrust({
				environment: {},
				transportSource: () =>
					'jar: this.client.state.cookieJar,\n            strictSSL: false,',
			});
		},
		{instanceOf: InsecureTransportError},
	);
	t.is(unpatched?.reason, 'unpatched-dependency');

	// Verification on, but not bound to the request host: still unpatched.
	const unbound = t.throws(
		() => {
			assertTransportTrust({
				environment: {},
				transportSource: () => 'jar: this.client.state.cookieJar,\n',
			});
		},
		{instanceOf: InsecureTransportError},
	);
	t.is(unbound?.reason, 'unpatched-dependency');

	const previous = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
	process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
	try {
		t.throws(
			() => {
				createInstagramApiClient();
			},
			{instanceOf: InsecureTransportError},
		);
	} finally {
		if (previous === undefined) {
			delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
		} else {
			process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = previous;
		}
	}
});
