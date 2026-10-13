import test from 'ava';
import {
	createInstagramApiClient,
	generateCompatibilityDevice,
	restoreCompatibilitySession,
} from '../../source/compatibility/client.js';
import {
	compatibilityReport,
	formatCompatibilityReport,
} from '../../source/compatibility/report.js';
import {
	dummyUsername,
	fixtureClient,
	forbidNetwork,
	legacyFixtureClient,
} from './_harness.js';

const network = forbidNetwork();
test.after.always(t => {
	network.restore();
	t.is(network.attempts, 0);
});

test('the formatted report makes the selected profile obvious', t => {
	const text = formatCompatibilityReport(compatibilityReport(fixtureClient()));
	t.is(
		text,
		[
			'Instagram-CLI compatibility profile',
			'',
			'Profile:            android-449.0.0.52.84-pixel-8-pro',
			'Profile status:     selected',
			'Profile source:     instagrapi 3.0.24 (a3b7538) default app profile 449.0.0.52.84 and device settings; build from Google factory images',
			'Evidence:           captured current Android profile (maintained-client default)',
			'Offline:            verified-coherent',
			'Live login:         unverified',
			'App version:        449.0.0.52.84',
			'Version code:       1079242191',
			'Bloks version:      799db3e387d7a21a19c72918b8698b6cd28a1516ade363792c100ed45a0f9f0b',
			'Android:            14 (SDK 34)',
			'Device:             Google/google Pixel 8 Pro (husky; husky; 480dpi; 1344x2992; build AP2A.240905.003)',
			'App minimum:        SDK 28 (met)',
			'REST app ID:        567067343352427',
			'REST capabilities:  3brTv10=',
			'MQTT app version:   449.0.0.52.84',
			'MQTT app ID:        567067343352427',
			'Matches profile:    yes',
			'Live validation:    not performed',
		].join('\n'),
	);
});

test('a restored legacy account reports retained hardware without identifiers', async t => {
	const legacy = legacyFixtureClient();
	const ig = createInstagramApiClient();
	generateCompatibilityDevice(ig, dummyUsername);
	const saved: Record<string, unknown> = await legacy.state.serialize();
	await restoreCompatibilitySession(ig, saved);
	const text = formatCompatibilityReport(compatibilityReport(ig));
	t.true(text.includes('App version:        449.0.0.52.84'));
	t.true(text.includes('Live login:         unverified'));
	t.true(text.includes('Android:            7.1.1 (SDK 25)'));
	t.true(text.includes('Device:             Xiaomi MI MAX 2 ('));
	t.true(text.includes('App minimum:        SDK 28 (not met by this device)'));
	t.true(text.includes('Matches profile:    no: device'));
	for (const secret of [
		ig.state.deviceId,
		ig.state.uuid,
		ig.state.phoneId,
		ig.state.adid,
		'offline-only-session',
		'offline-csrf',
		'123456789',
		dummyUsername,
	]) {
		t.false(text.includes(secret));
	}
});
