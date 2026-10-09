import {createHash} from 'node:crypto';
import test from 'ava';
import {IgApiClientExt} from 'instagram_mqtt';
import {
	currentCompatibilityProfile as profile,
	formatDeviceString,
} from '../../source/compatibility/profile.js';
import {
	applyCompatibilityProfile,
	createInstagramApiClient,
	generateCompatibilityDevice,
	realtimeCompatibilityOptions,
} from '../../source/compatibility/client.js';
import baseline from './_fixtures/compatibility-baseline.json' with {type: 'json'};

const hash = (value: string): string =>
	createHash('sha256').update(value).digest('hex');

test('owned application identity matches the pre-extraction baseline', t => {
	const ig = createInstagramApiClient();
	generateCompatibilityDevice(ig, 'offline-profile-fixture');
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

test('device pool and 100 synthetic username identities remain byte-equivalent', t => {
	t.is(profile.devices.length, 40);
	t.is(profile.builds.length, 16);
	t.is(
		hash(
			JSON.stringify(profile.devices.map(device => formatDeviceString(device))),
		),
		baseline.devicesSha256,
	);
	t.is(hash(JSON.stringify(profile.builds)), baseline.buildsSha256);
	const identities = Array.from({length: 100}, (_, index) => {
		const ig = createInstagramApiClient();
		const original = new IgApiClientExt();
		const seed = `offline-seed-${index}`;
		generateCompatibilityDevice(ig, seed);
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

test('profile fields are structurally valid without claiming modern compatibility', t => {
	t.regex(profile.appVersion, /^\d+(?:\.\d+){4}$/);
	t.regex(profile.appVersionCode, /^\d+$/);
	t.regex(profile.appId, /^\d+$/);
	t.regex(profile.bloksVersionId, /^[\da-f]{64}$/);
	t.regex(profile.signature.key, /^[\da-f]{64}$/);
	t.regex(profile.capabilities, /^[\dA-Za-z+/]+={0,2}$/);
	for (const device of profile.devices) {
		t.true(device.androidSdk >= 23 && device.androidSdk <= 27);
		t.regex(device.androidRelease, /^[678](?:\.\d+){1,2}$/);
		t.regex(device.dpi, /^\d+dpi$/);
		t.regex(device.resolution, /^\d+x\d+$/);
		for (const field of [
			device.manufacturer,
			device.model,
			device.device,
			device.cpu,
		]) {
			t.true(field.length > 0 && !field.includes(';'));
		}
	}
});

test('applying a profile changes only this instance and leaves account identity intact', t => {
	const ig = createInstagramApiClient();
	generateCompatibilityDevice(ig, 'offline-profile-fixture');
	const other = createInstagramApiClient();
	const original = new IgApiClientExt();
	const originalVersion = original.state.appVersion;
	const before = {...ig.state};
	applyCompatibilityProfile(ig, {
		...profile,
		appVersion: '0.0.0.0.1',
		capabilities: 'AA==',
	});
	t.is(ig.state.appVersion, '0.0.0.0.1');
	t.is(other.state.appVersion, baseline.appVersion);
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
