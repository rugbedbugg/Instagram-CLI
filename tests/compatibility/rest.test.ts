import {Buffer} from 'node:buffer';
import {createHmac} from 'node:crypto';
import test from 'ava';
import {currentCompatibilityProfile as profile} from '../../source/compatibility/profile.js';
import baseline from './_fixtures/rest-baseline.json' with {type: 'json'};
import identity from './_fixtures/compatibility-baseline.json' with {type: 'json'};
import {
	captureRest,
	dummyPassword,
	dummyUsername,
	dummyUserId,
	fixtureClient,
	forbidNetwork,
	hash,
	legacyFixtureClient,
	prepareLoginEncryption,
} from './_harness.js';

const network = forbidNetwork();
test.after.always(t => {
	network.restore();
	t.is(network.attempts, 0, 'No HTTP, TLS, fetch, or socket fallback was used');
});

const paths = {
	async login(ig: ReturnType<typeof fixtureClient>) {
		prepareLoginEncryption(ig);
		return ig.account.login(dummyUsername, dummyPassword);
	},
	async launcher(ig: ReturnType<typeof fixtureClient>) {
		await ig.launcher.preLoginSync();
	},
	async launcherAuthenticated(ig: ReturnType<typeof fixtureClient>) {
		await ig.launcher.postLoginSync();
	},
	async loginExperiments(ig: ReturnType<typeof fixtureClient>) {
		await ig.qe.syncLoginExperiments();
	},
	async experiments(ig: ReturnType<typeof fixtureClient>) {
		await ig.qe.syncExperiments();
	},
	reels: async (ig: ReturnType<typeof fixtureClient>) =>
		ig.feed.reelsTray('cold_start').request(),
	timeline: async (ig: ReturnType<typeof fixtureClient>) =>
		ig.feed.timeline('cold_start_fetch').request(),
};

for (const name of Object.keys(paths) as Array<keyof typeof paths>) {
	test(`legacy reference ${name} request identity and encoded form match the M1 baseline`, async t => {
		const ig = legacyFixtureClient();
		const {wire, form, payload, signedJson} = await captureRest(ig, async () =>
			paths[name](ig),
		);
		const expected = baseline.routes[name];
		t.is(wire.path, expected.path);
		t.is(wire.method, expected.method);
		for (const [header, value] of Object.entries(baseline.headers)) {
			t.is(wire.headers[header], value, `Header ${header}`);
		}

		t.deepEqual([...form.keys()].sort(), expected.formKeys);
		t.deepEqual(Object.keys(payload).sort(), expected.payloadKeys);
		t.is(wire.headers['x-ig-device-id'], ig.state.uuid);
		t.is(wire.headers['x-ig-android-id'], ig.state.deviceId);
		t.regex(String(wire.headers['x-pigeon-session-id']), /^[\da-f-]{36}$/);
		t.regex(String(wire.headers['x-pigeon-rawclienttime']), /^\d+\.\d{3}$/);
		t.is(wire.headers['x-ig-www-claim'], '0');
		if (signedJson) {
			t.is(form.get('ig_sig_key_version'), '4');
			t.is(
				form.get('signed_body'),
				`${createHmac('sha256', identity.signatureKey).update(signedJson).digest('hex')}.${signedJson}`,
			);
		} else {
			t.false(form.has('signed_body'));
		}

		t.is(
			typeof payload['configs'] === 'string'
				? hash(payload['configs'])
				: undefined,
			'configsSha256' in expected ? expected.configsSha256 : undefined,
		);
	});
}

// Independent literals for the selected profile; see profile.test.ts.
const selectedHeaders: Record<string, string> = {
	'user-agent':
		'Instagram 448.0.0.0.20 Android (34/14; 480dpi; 1344x2992; Google/google; Pixel 8 Pro; husky; husky; en_US; 1065560286)',
	'x-ig-app-id': '567067343352427',
	'x-bloks-version-id':
		'0bc46a03e177bfc9bc8d611918815acf248fa9c77754d807d6a5951dc9ce9432',
	'x-ig-capabilities': '3brTv10=',
};
const legacyMarkers = [
	identity.appVersion,
	identity.appVersionCode,
	identity.bloksVersionId,
	'MI MAX 2',
	identity.build,
];
// The selected profile declares four supported capabilities instead of six.
const selectedKeys = (keys: string[]) =>
	keys.filter(key => {
		const index = /^supported_capabilities_new\[(\d+)]/.exec(key)?.[1];
		return index === undefined || Number(index) < 4;
	});

for (const name of Object.keys(paths) as Array<keyof typeof paths>) {
	test(`selected profile identity reaches the real ${name} request`, async t => {
		const ig = fixtureClient();
		const {wire, form, payload, signedJson} = await captureRest(ig, async () =>
			paths[name](ig),
		);
		const expected = baseline.routes[name];
		t.is(wire.path, expected.path);
		t.is(wire.method, expected.method);
		for (const [header, value] of Object.entries(baseline.headers)) {
			t.is(
				wire.headers[header],
				selectedHeaders[header] ?? value,
				`Header ${header}`,
			);
		}

		t.deepEqual([...form.keys()].sort(), selectedKeys(expected.formKeys));
		t.deepEqual(
			Object.keys(payload).sort(),
			selectedKeys(expected.payloadKeys),
		);
		t.is(wire.headers['x-ig-device-id'], ig.state.uuid);
		t.is(wire.headers['x-ig-android-id'], ig.state.deviceId);
		if (signedJson) {
			t.is(form.get('ig_sig_key_version'), profile.signature.version);
			t.is(
				form.get('signed_body'),
				`${createHmac('sha256', profile.signature.key).update(signedJson).digest('hex')}.${signedJson}`,
			);
		} else {
			t.false(form.has('signed_body'));
		}

		t.is(
			typeof payload['configs'] === 'string'
				? hash(payload['configs'])
				: undefined,
			'configsSha256' in expected ? expected.configsSha256 : undefined,
		);
		const wireText = `${JSON.stringify(wire.headers)}${wire.body}`;
		for (const marker of legacyMarkers) {
			t.false(wireText.includes(marker), `No legacy ${marker}`);
		}
	});
}

test('login uses synthetic identity, real password encryption, and the inherited country code', async t => {
	const ig = fixtureClient(profile, false);
	prepareLoginEncryption(ig);
	const {payload, wire} = await captureRest(ig, async () =>
		ig.account.login(dummyUsername, dummyPassword),
	);
	t.is(payload['username'], dummyUsername);
	t.is(payload['guid'], ig.state.uuid);
	t.is(payload['device_id'], ig.state.deviceId);
	t.is(payload['phone_id'], ig.state.phoneId);
	t.is(payload['adid'], ig.state.adid);
	t.is(payload['_csrftoken'], 'missing');
	t.is(payload['google_tokens'], '[]');
	t.is(payload['login_attempt_count'], 0);
	t.is(payload['country_codes'], '[{"country_code":"1","source":"default"}]');
	t.is(
		payload['jazoest'],
		`2${[...ig.state.phoneId].reduce((sum, char) => sum + char.codePointAt(0)!, 0)}`,
	);
	const encrypted = String(payload['enc_password']);
	t.regex(encrypted, /^#PWD_INSTAGRAM:4:\d+:[\dA-Za-z+/]+=*$/);
	const binary = Buffer.from(encrypted.split(':')[3]!, 'base64');
	t.is(binary[0], 1);
	t.is(binary[1], 1);
	t.true(binary.length > 256);
	t.false(wire.body.includes(dummyPassword));
	t.false('waterfall_id' in payload);
});

test('login without an encryption key constructs guest QE before any login form', async t => {
	const ig = fixtureClient(profile, false);
	const {wire, payload} = await captureRest(ig, async () =>
		ig.account.login(dummyUsername, dummyPassword),
	);
	t.is(wire.path, '/api/v1/qe/sync/');
	t.deepEqual(Object.keys(payload).sort(), ['experiments', 'id']);
	t.is(payload['id'], ig.state.uuid);
	t.is(wire.headers['x-device-id'], ig.state.uuid);
	t.is(hash(String(payload['experiments'])), identity.loginExperimentsSha256);
});

for (const name of ['experiments', 'launcherAuthenticated'] as const) {
	test(`authenticated ${name} binds the saved user and device identifiers`, async t => {
		const ig = fixtureClient();
		const {payload} = await captureRest(ig, async () => paths[name](ig));
		t.is(payload['id'], dummyUserId);
		t.is(payload['_uid'], dummyUserId);
		t.is(payload['_uuid'], ig.state.uuid);
		t.is(payload['_csrftoken'], 'offline-csrf');
		t.is(
			typeof payload['experiments'] === 'string'
				? hash(payload['experiments'])
				: undefined,
			name === 'experiments' ? identity.experimentsSha256 : undefined,
		);
	});
}

test('cold-start reels carries every supported capability through the real form encoder', async t => {
	const ig = fixtureClient();
	const {form} = await captureRest(ig, async () =>
		ig.feed.reelsTray('cold_start').request(),
	);
	for (const [index, entry] of profile.supportedCapabilities.entries()) {
		t.is(form.get(`supported_capabilities_new[${index}][name]`), entry.name);
		t.is(
			form.get(`supported_capabilities_new[${index}][value]`),
			String(entry.value),
		);
	}

	t.is(form.get('reason'), 'cold_start');
	t.is(form.get('_uuid'), ig.state.uuid);
});

test('cold-start timeline uses UUID as device_id and the advertising and phone identities', async t => {
	const ig = fixtureClient();
	const {wire, form} = await captureRest(ig, async () =>
		ig.feed.timeline('cold_start_fetch').request(),
	);
	t.is(wire.headers['x-google-ad-id'], ig.state.adid);
	t.is(wire.headers['x-device-id'], ig.state.uuid);
	t.is(form.get('device_id'), ig.state.uuid);
	t.is(form.get('_uuid'), ig.state.uuid);
	t.is(form.get('phone_id'), ig.state.phoneId);
	t.regex(form.get('client_session_id')!, /^[\da-f-]{36}$/);
	t.is(form.get('timezone_offset'), '0');
	t.is(form.get('reason'), 'cold_start_fetch');
});
