import test from 'ava';
import {AuthenticationCoordinator} from '../../source/auth/coordinator.js';
import {InstagramClient} from '../../source/client.js';
import {ConfigManager} from '../../source/config.js';
import {forbidNetwork} from '../compatibility/_harness.js';
import {
	ScriptedInstagram,
	endObservers,
	loginRejected,
	ok,
	preLogin,
	savedBytes,
	seedPreviousSession,
	settle,
	step,
	syntheticCode,
	syntheticPassword,
	syntheticUserId,
	type ScriptedStep,
} from './_offline-instagram.js';

const network = forbidNetwork();
test.before(async () => {
	await ConfigManager.getInstance().initialize();
});
test.after.always(t => {
	network.restore();
	t.is(network.attempts, 0);
});

const challengePath = `/challenge/${syntheticUserId}/synthetic-nonce/`;

/** A login that reaches the email-code step of a checkpoint. */
async function pendingChallengeCode(username: string) {
	const client = new InstagramClient();
	const server = new ScriptedInstagram(client.getInstagramClient());
	const coordinator = new AuthenticationCoordinator(client);
	server.expect(
		...preLogin(),
		loginRejected({
			message: 'challenge_required',
			error_type: 'checkpoint_challenge_required',
			challenge: {api_path: challengePath},
		}),
		step(
			'POST',
			`/api/v1/challenge/reset/${syntheticUserId}/synthetic-nonce/`,
			ok({step_name: 'verify_email', step_data: {}}),
		),
	);
	await coordinator.loginWithCredentials(username, syntheticPassword, {
		initializeRealtime: false,
	});
	await coordinator.requestCheckpointCode();
	return {client, server, coordinator};
}

for (const [name, respond, expected] of [
	[
		'a transport failure is a network error',
		{networkError: 'ECONNRESET'},
		{kind: 'network-error'},
	],
	[
		'a rejected code stays distinguishable',
		{status: 400, body: {status: 'fail', message: 'synthetic wrong code'}},
		{kind: 'verification-code-rejected'},
	],
] as Array<[string, ScriptedStep['respond'], {kind: string}]>) {
	test.serial(
		`challenge code submission: ${name}, sent once, session untouched`,
		async t => {
			const username = `challenge-error-${expected.kind}`;
			const before = await seedPreviousSession(username);
			const {client, server, coordinator} =
				await pendingChallengeCode(username);
			const baseline = endObservers(client);
			server.expect(step('POST', `/api/v1${challengePath}`, respond));

			const outcome = await coordinator.submitVerificationCode(syntheticCode);
			await settle();

			t.deepEqual(outcome, expected);
			t.deepEqual(server.unexpected, []);
			t.is(server.pending, 0);
			t.is(server.requestsTo(`/api/v1${challengePath}`).length, 1);
			t.is(endObservers(client), baseline);
			t.is(await savedBytes(username), before);
		},
	);
}
