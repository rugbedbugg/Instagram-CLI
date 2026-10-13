import {Buffer} from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'ava';
import debug from 'debug';
import {IgNetworkError} from 'instagram-private-api';
import {AuthenticationCoordinator} from '../../source/auth/coordinator.js';
import {InstagramClient} from '../../source/client.js';
import {ConfigManager} from '../../source/config.js';
import {
	createContextualLogger,
	getLogger,
	initializeLogger,
} from '../../source/utils/logger.js';
import {forbidNetwork} from '../compatibility/_harness.js';
import {
	ScriptedInstagram,
	loggedInUser,
	loginRejected,
	ok,
	preLogin,
	signedPayload,
	step,
	syntheticPassword,
	syntheticUserId,
} from '../auth/_offline-instagram.js';

// Verbose mode: every namespace the dependencies and these tests use. (A bare
// `*` would also switch on the test runner's own event tracing.)
process.env['DEBUG'] = 'ig:*,mqtt:*,unreviewed:*';

const marker = {
	cookie: 'cookie-marker-sessionid-41c7',
	tokenSession: 'token-marker-session-9e2d',
	code: 'vcode-marker-482915',
	identifier: 'tfa-marker-identifier-63b0',
	nonce: 'nonce-marker-77aa',
	challengeContext: 'challenge-context-marker-5f1e',
	contactPoint: 'contact-marker@example.invalid',
	body: 'body-marker-d93c',
	form: 'form-marker-enc-8811',
	authorization: 'auth-header-marker-2c4f',
	jar: 'jar-marker-7a90',
	mqtt: 'mqtt-session-marker-0b3e',
};
const token = Buffer.from(
	JSON.stringify({ds_user_id: syntheticUserId, sessionid: marker.tokenSession}),
).toString('base64');
const secrets: string[] = [syntheticPassword, ...Object.values(marker), token];

const network = forbidNetwork();
const output: string[] = [];
const originalWrite = {
	stdout: process.stdout.write.bind(process.stdout),
	stderr: process.stderr.write.bind(process.stderr),
};

test.before(async () => {
	await ConfigManager.getInstance().initialize();
	await initializeLogger();
	for (const stream of ['stdout', 'stderr'] as const) {
		process[stream].write = ((chunk: string | Uint8Array, ...rest: any[]) => {
			output.push(String(chunk));
			// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
			return originalWrite[stream](chunk, ...rest);
		}) as typeof process.stdout.write;
	}
});
test.after.always(t => {
	process.stdout.write = originalWrite.stdout;
	process.stderr.write = originalWrite.stderr;
	network.restore();
	t.is(network.attempts, 0);
});

const sessionCookies = [
	`ds_user_id=${syntheticUserId}; Domain=.instagram.com; Path=/`,
	`sessionid=${marker.cookie}; Domain=.instagram.com; Path=/; Secure; HttpOnly`,
	'csrftoken=csrf-not-a-marker; Domain=.instagram.com; Path=/',
];
const challengePath = `/challenge/${syntheticUserId}/${marker.nonce}/`;

function scenario() {
	const client = new InstagramClient();
	const server = new ScriptedInstagram(client.getInstagramClient());
	return {server, coordinator: new AuthenticationCoordinator(client)};
}

async function login(coordinator: AuthenticationCoordinator, name: string) {
	return coordinator.loginWithCredentials(`log-${name}`, syntheticPassword, {
		initializeRealtime: false,
	});
}

const encryptedPasswords: string[] = [];
function captureEncryptedPassword(server: ScriptedInstagram) {
	for (const request of server.requestsTo('/api/v1/accounts/login/')) {
		const encrypted = signedPayload(request.body)['enc_password'];
		if (typeof encrypted === 'string') {
			encryptedPasswords.push(encrypted);
		}
	}
}

test.serial(
	'authentication scenarios, verbose debug output and nested errors log no secrets',
	async t => {
		// 1. Success, with a bearer token used by the following requests.
		{
			const {server, coordinator} = scenario();
			server.expect(
				...preLogin(),
				step(
					'POST',
					'/api/v1/accounts/login/',
					ok(
						{logged_in_user: loggedInUser('log-success')},
						{
							'set-cookie': sessionCookies,
							'ig-set-authorization': `Bearer IGT:2:${token}`,
						},
					),
				),
				step('POST', '/api/v1/feed/reels_tray/', ok({tray: []})),
				step('POST', '/api/v1/feed/timeline/', ok({feed_items: []})),
			);
			t.like(await login(coordinator, 'success'), {kind: 'authenticated'});
			t.true(
				server
					.requestsTo('/api/v1/feed/timeline/')
					.some(request => request.headers['authorization']?.includes(token)),
			);
			captureEncryptedPassword(server);
		}

		// 2. Rejected password, with a body the server may echo into logs.
		{
			const {server, coordinator} = scenario();
			server.expect(
				...preLogin(),
				loginRejected({
					error_type: 'bad_password',
					message: 'synthetic',
					debug_info: marker.body,
				}),
			);
			t.like(await login(coordinator, 'bad-password'), {
				kind: 'invalid-credentials',
			});
			captureEncryptedPassword(server);
		}

		// 3 and 4. Two-factor required, then a rejected code.
		{
			const {server, coordinator} = scenario();
			server.expect(
				...preLogin(),
				loginRejected({
					message: '',
					two_factor_required: true,
					two_factor_info: {
						two_factor_identifier: marker.identifier,
						totp_two_factor_on: true,
						obfuscated_phone_number: marker.body,
					},
				}),
				step('POST', '/api/v1/accounts/two_factor_login/', {
					status: 400,
					body: {status: 'fail', message: marker.body},
				}),
			);
			t.like(await login(coordinator, 'two-factor'), {
				kind: 'two-factor-required',
			});
			t.like(await coordinator.submitVerificationCode(marker.code), {
				kind: 'failed',
			});
			captureEncryptedPassword(server);
		}

		// 5. Challenge with context the client cannot complete.
		{
			const {server, coordinator} = scenario();
			server.expect(
				...preLogin(),
				loginRejected({
					message: 'challenge_required',
					error_type: 'checkpoint_challenge_required',
					challenge: {
						api_path: challengePath,
						challenge_context: marker.challengeContext,
					},
				}),
				step(
					'POST',
					`/api/v1/challenge/reset/${syntheticUserId}/${marker.nonce}/`,
					ok({
						step_name: 'submit_phone',
						step_data: {contact_point: marker.contactPoint},
						challenge_context: marker.challengeContext,
					}),
				),
			);
			t.like(await login(coordinator, 'challenge'), {
				kind: 'checkpoint-required',
			});
			t.like(await coordinator.requestCheckpointCode(), {
				kind: 'unsupported-challenge',
			});
			captureEncryptedPassword(server);
		}

		// 6. Rate limiting.
		{
			const {server, coordinator} = scenario();
			server.expect(
				...preLogin(),
				step('POST', '/api/v1/accounts/login/', {
					status: 429,
					body: {status: 'fail', message: 'Please wait', debug: marker.body},
				}),
			);
			t.like(await login(coordinator, 'rate-limited'), {kind: 'rate-limited'});
			captureEncryptedPassword(server);
		}

		// 7. Transport failure.
		{
			const {server, coordinator} = scenario();
			server.expect(
				...preLogin(),
				step('POST', '/api/v1/accounts/login/', {networkError: 'ECONNRESET'}),
			);
			t.like(await login(coordinator, 'transport'), {kind: 'network-error'});
			captureEncryptedPassword(server);
		}

		// 9 and 11. Dependency debug output in every namespace, REST and MQTT.
		debug('ig:account')(
			`Login failed, two factor auth required: ${JSON.stringify({two_factor_identifier: marker.identifier})}`,
		);
		debug('ig:request')(
			`Requesting GET /api/v1/feed/?access_token=${marker.tokenSession}`,
		);
		debug('ig:state')(`Could not parse authorization: ${token}`);
		debug('ig:mqtt:realtime:message')(
			`Received on /ig_message_sync: ${JSON.stringify({text: marker.body})}`,
		);
		debug('ig:mqtt:fbns')(`Received auth: {"pw":"${marker.mqtt}"}`);
		debug('mqtt:client:packet')(
			`Writing CONNECT password=sessionid=${marker.mqtt}`,
		);
		debug('unreviewed:namespace')(`Authorization: Bearer IGT:2:${token}`);

		// 10. Serialized nested and credential-bearing errors.
		const logger = createContextualLogger('ConfidentialityTest');
		// The shape request-promise rejects with; typed by the dependency as Error.
		const requestError: unknown = {
			name: 'RequestError',
			message: 'Error: socket hang up',
			cause: Object.assign(new Error('socket hang up'), {code: 'ECONNRESET'}),
			options: {
				form: {enc_password: `#PWD_INSTAGRAM:4:1:${marker.form}`},
				headers: {Authorization: `Bearer IGT:2:${marker.authorization}`},
				jar: {cookie: `sessionid=${marker.jar}`},
			},
		};
		const credentialBearing = new IgNetworkError(requestError as Error);
		t.false('options' in credentialBearing);
		logger.error('Request failed', credentialBearing);
		logger.error('Request context', {
			attempt: 1,
			error: credentialBearing,
			headers: {Cookie: `sessionid=${marker.jar}`},
			nested: {
				password: syntheticPassword,
				deeper: {authorization: `Bearer ${marker.authorization}`},
			},
		});
		logger.error(
			'Wrapped failure',
			new Error(`outer sessionid=${marker.jar}`, {
				cause: new Error(`inner Authorization: Bearer IGT:2:${token}`),
			}),
		);
		logger.error(
			'Response failure',
			Object.assign(
				new Error('POST /api/v1/accounts/login/ - 400 Bad Request; synthetic'),
				{
					name: 'IgLoginBadPasswordError',
					response: {
						statusCode: 400,
						body: {debug: marker.body},
						request: {
							headers: {Authorization: `Bearer ${marker.authorization}`},
							body: `enc_password=#PWD_INSTAGRAM:4:1:${marker.form}`,
						},
					},
				},
			),
		);
		logger.error(
			'Realtime Error',
			new Error(`MQTT for sessionid=${marker.mqtt}`),
		);
		logger.info(`Submitted verification_code=${marker.code}`);

		await getLogger().flush();
		const logFile = getLogger().getLogFilePath();
		const log = await fs.readFile(logFile, 'utf8');
		const surfaces = [
			log,
			JSON.stringify(getLogger().getBufferedLogs()),
			output.join(''),
		];

		// One password submission per scenario that reached the login request.
		t.is(encryptedPasswords.length, 6);
		for (const secret of [...secrets, ...encryptedPasswords]) {
			for (const surface of surfaces) {
				t.false(surface.includes(secret), `a secret reached the log output`);
			}
		}

		// Useful, non-sensitive diagnostics remain.
		for (const expected of [
			/Requesting POST \/api\/v1\/accounts\/login\//,
			/Request POST \/api\/v1\/accounts\/login\/ failed \(response body withheld\)/,
			/Login ended with invalid-credentials: IgLoginBadPasswordError \(HTTP 400\)/,
			/Login ended with two-factor-required/,
			/Login ended with rate-limited/,
			/Login ended with network-error/,
			/Requesting POST \/api\/v1\/challenge\/reset\/5550001\/\[redacted]\//,
			/ig:account: Login failed, two factor auth required \(details withheld\)/,
			/ig:request: Requesting GET \/api\/v1\/feed\/$/m,
			/ig:mqtt:realtime:message: Received on \/ig_message_sync \(payload withheld\)/,
			/mqtt:client:packet: message withheld \(\d+ chars\)/,
			/RequestError: Error: socket hang up\nCaused by: Error \[ECONNRESET]/,
			/IgLoginBadPasswordError \(HTTP 400\): POST \/api\/v1\/accounts\/login\//,
			/"error":"RequestError/,
		]) {
			t.regex(log, expected);
		}

		// Logs are private to the user.
		const fileStat = await fs.stat(logFile);
		t.is(fileStat.mode & 0o777, 0o600);
		const directoryStat = await fs.stat(path.dirname(logFile));
		t.is(directoryStat.mode & 0o777, 0o700);
	},
);
