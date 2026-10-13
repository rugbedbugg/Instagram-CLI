import test from 'ava';
import {IgApiClientExt} from 'instagram_mqtt';
import {
	android448HistoricalProfile as historical448,
	android448Release,
	android449Release,
	currentCompatibilityProfile as profile,
	declaredReleases,
	defineCompatibilityProfile,
	formatDeviceString,
	isDeclaredRelease,
	pixel8ProAndroid14,
} from '../../source/compatibility/profile.js';
import {
	legacyInheritedProfile as legacy,
	legacyInheritedRelease,
} from '../../source/compatibility/legacy-profile.js';
import {
	applyCompatibilityProfile,
	createInstagramApiClient,
	generateCompatibilityDevice,
	realtimeCompatibilityOptions,
} from '../../source/compatibility/client.js';
import baseline from './_fixtures/compatibility-baseline.json' with {type: 'json'};
import {
	dummyUsername,
	fixtureClient,
	generateLegacyDevice,
	hash,
	legacyFixtureClient,
} from './_harness.js';

// Independent literals: a profile update must change these deliberately.
const selected = {
	id: 'android-449.0.0.52.84-pixel-8-pro',
	release: {
		appVersion: '449.0.0.52.84',
		appVersionCode: '1079242191',
		bloksVersionId:
			'799db3e387d7a21a19c72918b8698b6cd28a1516ade363792c100ed45a0f9f0b',
	},
	device: {
		androidSdk: 34,
		androidRelease: '14',
		dpi: '480dpi',
		resolution: '1344x2992',
		manufacturer: 'Google/google',
		model: 'Pixel 8 Pro',
		device: 'husky',
		cpu: 'husky',
		build: 'AP2A.240905.003',
	},
	appUserAgent:
		'Instagram 449.0.0.52.84 Android (34/14; 480dpi; 1344x2992; Google/google; Pixel 8 Pro; husky; husky; en_US; 1079242191)',
	supportedCapabilities: [
		{
			name: 'SUPPORTED_SDK_VERSIONS',
			value: Array.from({length: 24}, (_, index) => `${119 + index}.0`).join(
				',',
			),
		},
		{name: 'FACE_TRACKER_VERSION', value: '14'},
		{name: 'COMPRESSION', value: 'ETC2_COMPRESSION'},
		{name: 'gyroscope', value: 'gyroscope_enabled'},
	],
};

test('the legacy reference still reproduces the M1 inherited identity exactly', t => {
	const ig = legacyFixtureClient();
	t.is(legacy.status, 'legacy-reference');
	t.is(ig.state.appVersion, baseline.appVersion);
	t.is(ig.state.appVersionCode, baseline.appVersionCode);
	t.is(ig.state.bloksVersionId, baseline.bloksVersionId);
	t.is(ig.state.fbAnalyticsApplicationId, baseline.appId);
	t.is(ig.state.capabilitiesHeader, baseline.capabilities);
	t.is(ig.state.signatureKey, baseline.signatureKey);
	t.is(ig.state.signatureVersion, baseline.signatureVersion);
	t.is(ig.state.userBreadcrumbKey, baseline.breadcrumbKey);
	t.is(ig.state.deviceString, baseline.deviceString);
	t.is(ig.state.build, baseline.build);
	t.is(ig.state.appUserAgent, baseline.appUserAgent);
	t.is(ig.state.webUserAgent, baseline.webUserAgent);
	t.deepEqual(ig.state.supportedCapabilities, baseline.supportedCapabilities);
	t.is(hash(ig.state.experiments), baseline.experimentsSha256);
	t.is(hash(ig.state.loginExperiments), baseline.loginExperimentsSha256);
});

test('the legacy device pool and 100 synthetic identities remain byte-equivalent', t => {
	t.is(legacy.devices.length, 40);
	t.is(legacy.builds.length, 16);
	t.is(
		hash(
			JSON.stringify(legacy.devices.map(device => formatDeviceString(device))),
		),
		baseline.devicesSha256,
	);
	t.is(hash(JSON.stringify(legacy.builds)), baseline.buildsSha256);
	const identities = Array.from({length: 100}, (_, index) => {
		const ig = createInstagramApiClient(legacy);
		const original = new IgApiClientExt();
		const seed = `offline-seed-${index}`;
		generateLegacyDevice(ig, seed);
		original.state.generateDevice(seed);
		const fields = (client: IgApiClientExt) => [
			client.state.deviceString,
			client.state.build,
			client.state.deviceId,
			client.state.uuid,
			client.state.phoneId,
			client.state.adid,
		];
		t.deepEqual(fields(ig), fields(original));
		return fields(ig);
	});
	t.is(hash(JSON.stringify(identities)), baseline.generatedIdentitiesSha256);
});

test('the selected profile is exactly the evidenced modern Android identity', t => {
	t.is(profile.id, selected.id);
	t.is(profile.status, 'selected');
	t.true(profile.source.includes('instagrapi 3.0.24 (a3b7538)'));
	t.deepEqual(profile.evidence, {
		summary: 'captured current Android profile (maintained-client default)',
		offline: 'verified-coherent',
		liveLogin: 'unverified',
	});
	t.deepEqual({...profile.release}, selected.release);
	t.deepEqual({...profile.device}, selected.device);
	t.deepEqual(profile.supportedCapabilities, selected.supportedCapabilities);
	const ig = fixtureClient();
	t.is(ig.state.appVersion, selected.release.appVersion);
	t.is(ig.state.appVersionCode, selected.release.appVersionCode);
	t.is(ig.state.bloksVersionId, selected.release.bloksVersionId);
	t.is(ig.state.appUserAgent, selected.appUserAgent);
	t.is(ig.state.build, selected.device.build);
	t.is(
		ig.state.webUserAgent,
		`Mozilla/5.0 (Linux; Android 14;  Pixel 8 Pro Build/AP2A.240905.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.135 Mobile Safari/537.36 ${selected.appUserAgent}`,
	);
	t.deepEqual(ig.state.supportedCapabilities, selected.supportedCapabilities);
});

test('the historical 448 profile remains reproducible but is never the default', t => {
	t.is(historical448.status, 'historical-reference');
	t.is(historical448.evidence.liveLogin, 'historical-success-later-failing');
	t.deepEqual(
		{...historical448.release},
		{
			appVersion: '448.0.0.0.20',
			appVersionCode: '1065560286',
			bloksVersionId:
				'0bc46a03e177bfc9bc8d611918815acf248fa9c77754d807d6a5951dc9ce9432',
		},
	);
	t.is(historical448.device, profile.device);
	const ig = fixtureClient(historical448);
	t.is(
		ig.state.appUserAgent,
		'Instagram 448.0.0.0.20 Android (34/14; 480dpi; 1344x2992; Google/google; Pixel 8 Pro; husky; husky; en_US; 1065560286)',
	);
	t.is(ig.state.bloksVersionId, historical448.release.bloksVersionId);
	t.not(profile.release, historical448.release);
	t.not(profile.id, historical448.id);
	t.is(legacy.evidence.liveLogin, 'known-failing');
	t.is(legacy.evidence.offline, 'inconsistent');
});

test('app version, version code and Bloks version belong to one declared release', t => {
	t.is(profile.release, android449Release);
	t.true(Object.isFrozen(profile.release));
	t.true(Object.isFrozen(profile.device));
	t.deepEqual(declaredReleases, [android449Release, android448Release]);
	t.true(isDeclaredRelease({...profile.release}));
	t.false(isDeclaredRelease(legacyInheritedRelease));
	for (const mixed of [
		{
			...android449Release,
			bloksVersionId: legacyInheritedRelease.bloksVersionId,
		},
		{...android449Release, bloksVersionId: android448Release.bloksVersionId},
		{...android449Release, appVersionCode: android448Release.appVersionCode},
		{...android448Release, bloksVersionId: android449Release.bloksVersionId},
		{
			...android449Release,
			appVersionCode: legacyInheritedRelease.appVersionCode,
		},
		{...legacyInheritedRelease, appVersion: android449Release.appVersion},
	]) {
		t.false(isDeclaredRelease(mixed));
		t.throws(() => defineCompatibilityProfile({...profile, release: mixed}), {
			message: /different releases/,
		});
	}
});

test('legacy inherited and selected profiles differ exactly in release, capabilities list and device', t => {
	const before = legacyFixtureClient();
	const after = fixtureClient();
	const fields = {
		appVersion: (ig: IgApiClientExt) => ig.state.appVersion,
		appVersionCode: (ig: IgApiClientExt) => ig.state.appVersionCode,
		bloksVersionId: (ig: IgApiClientExt) => ig.state.bloksVersionId,
		supportedCapabilities: (ig: IgApiClientExt) =>
			JSON.stringify(ig.state.supportedCapabilities),
		deviceString: (ig: IgApiClientExt) => ig.state.deviceString,
		build: (ig: IgApiClientExt) => ig.state.build,
		appUserAgent: (ig: IgApiClientExt) => ig.state.appUserAgent,
		webUserAgent: (ig: IgApiClientExt) => ig.state.webUserAgent,
		appId: (ig: IgApiClientExt) => ig.state.fbAnalyticsApplicationId,
		capabilities: (ig: IgApiClientExt) => ig.state.capabilitiesHeader,
		signatureKey: (ig: IgApiClientExt) => ig.state.signatureKey,
		signatureVersion: (ig: IgApiClientExt) => ig.state.signatureVersion,
		breadcrumbKey: (ig: IgApiClientExt) => ig.state.userBreadcrumbKey,
		experiments: (ig: IgApiClientExt) => ig.state.experiments,
		loginExperiments: (ig: IgApiClientExt) => ig.state.loginExperiments,
		language: (ig: IgApiClientExt) => ig.state.language,
	};
	const changed = Object.entries(fields)
		.filter(([, read]) => read(before) !== read(after))
		.map(([name]) => name);
	t.deepEqual(changed, [
		'appVersion',
		'appVersionCode',
		'bloksVersionId',
		'supportedCapabilities',
		'deviceString',
		'build',
		'appUserAgent',
		'webUserAgent',
	]);
	t.deepEqual(legacy.realtime, profile.realtime);
	t.deepEqual(
		realtimeCompatibilityOptions(legacy),
		realtimeCompatibilityOptions(),
	);
});

test('new accounts never regress to 416 or 448, the Android 6–8 pool, or an old Bloks pairing', t => {
	const legacyDevices = new Set(
		legacy.devices.map(device => formatDeviceString(device)),
	);
	const legacyBuilds = new Set(legacy.builds);
	const seen = new Set<string>();
	for (let index = 0; index < 100; index++) {
		const ig = createInstagramApiClient();
		generateCompatibilityDevice(ig, `offline-seed-${index}`);
		t.false(ig.state.appVersion.startsWith('416.'));
		t.not(ig.state.appVersionCode, legacyInheritedRelease.appVersionCode);
		t.not(ig.state.bloksVersionId, legacyInheritedRelease.bloksVersionId);
		t.false(ig.state.appVersion.startsWith('448.'));
		t.not(ig.state.appVersionCode, android448Release.appVersionCode);
		t.not(ig.state.bloksVersionId, android448Release.bloksVersionId);
		t.is(ig.state.appVersion, android449Release.appVersion);
		t.is(ig.state.deviceString, formatDeviceString(pixel8ProAndroid14));
		t.is(ig.state.build, pixel8ProAndroid14.build);
		t.false(legacyDevices.has(ig.state.deviceString));
		t.false(legacyBuilds.has(ig.state.build));
		t.is(Number(ig.state.deviceString.split('/')[0]), 34);
		t.regex(ig.state.deviceId, /^android-[\da-f]{16}$/);
		for (const id of [ig.state.uuid, ig.state.phoneId, ig.state.adid]) {
			t.regex(id, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/);
		}

		t.is(new Set([ig.state.uuid, ig.state.phoneId, ig.state.adid]).size, 3);
		seen.add(ig.state.deviceId);
	}

	t.is(seen.size, 100, 'Each account receives its own identifiers');
});

test('new-account identifiers are stable per username and independent of the app profile', t => {
	const identifiers = (ig: IgApiClientExt) => [
		ig.state.deviceId,
		ig.state.uuid,
		ig.state.phoneId,
		ig.state.adid,
	];
	const first = fixtureClient();
	const second = fixtureClient();
	t.deepEqual(identifiers(first), identifiers(second));
	const changedRelease = {
		...profile,
		release: {...profile.release, appVersion: '0.0.0.0.1'},
	};
	t.deepEqual(identifiers(fixtureClient(changedRelease)), identifiers(first));
	const other = createInstagramApiClient();
	generateCompatibilityDevice(other, dummyUsername.toUpperCase());
	t.not(other.state.deviceId, first.state.deviceId);
});

test('the device template is internally plausible', t => {
	const {device} = profile;
	t.is(profile.minimumAndroidSdk, 28);
	t.true(device.androidSdk >= profile.minimumAndroidSdk);
	t.true(
		legacy.devices.every(old => old.androidSdk < profile.minimumAndroidSdk),
		'No M1 pool device can install the selected release',
	);
	t.throws(
		() =>
			defineCompatibilityProfile({
				...profile,
				device: {...device, androidSdk: 27, androidRelease: '8.1.0'},
			}),
		{message: /cannot install/},
	);
	// Android 14 is API level 34; Pixel 8 Pro is 1344x2992 at 489 ppi (xxhdpi).
	t.is(device.androidSdk, 34);
	t.is(device.androidRelease, '14');
	t.is(device.resolution, '1344x2992');
	t.is(device.dpi, '480dpi');
	t.regex(device.manufacturer, /^Google\/google$/);
	t.is(device.device, 'husky');
	t.regex(device.build, /^AP2A\.\d{6}\.\d{3}$/);
	for (const field of [
		device.manufacturer,
		device.model,
		device.device,
		device.cpu,
		device.build,
	]) {
		t.true(field.length > 0 && !field.includes(';'));
	}
});

test('applying a profile changes only this instance and leaves account identity intact', t => {
	const ig = fixtureClient();
	const other = createInstagramApiClient();
	const original = new IgApiClientExt();
	const originalVersion = original.state.appVersion;
	const before = {...ig.state};
	applyCompatibilityProfile(ig, {
		...profile,
		release: {...profile.release, appVersion: '0.0.0.0.1'},
		capabilities: 'AA==',
	});
	t.is(ig.state.appVersion, '0.0.0.0.1');
	t.is(other.state.appVersion, profile.release.appVersion);
	t.is(original.state.appVersion, originalVersion);
	t.not(ig.state.constants, other.state.constants);
	t.not(
		ig.state.supportedCapabilities[0],
		other.state.supportedCapabilities[0],
	);
	t.is(ig.state.deviceString, before.deviceString);
	t.is(ig.state.build, before.build);
	t.is(ig.state.uuid, before.uuid);
	t.is(ig.state.phoneId, before.phoneId);
	t.is(ig.state.adid, before.adid);
	t.is(ig.state.deviceId, before.deviceId);
	t.false(Object.keys(ig.state).includes('webUserAgent'));
});

test('MQTT public overrides carry the profile application ID and transport capabilities', t => {
	const {connectOverrides} = realtimeCompatibilityOptions();
	t.deepEqual(connectOverrides, {
		appId: BigInt(baseline.mqtt.appId),
		clientCapabilities: baseline.mqtt.clientCapabilities,
		endpointCapabilities: baseline.mqtt.endpointCapabilities,
		publishFormat: baseline.mqtt.publishFormat,
		clientStack: baseline.mqtt.clientStack,
	});
});
