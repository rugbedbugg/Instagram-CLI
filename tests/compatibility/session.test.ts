import {Buffer} from 'node:buffer';
import test from 'ava';
import {IgApiClientExt} from 'instagram_mqtt';
import {ConfigManager} from '../../source/config.js';
import {SessionManager} from '../../source/session.js';
import {
	applyCompatibilityProfile,
	createInstagramApiClient,
	generateCompatibilityDevice,
} from '../../source/compatibility/client.js';
import {currentCompatibilityProfile as profile} from '../../source/compatibility/profile.js';
import {compatibilityReport} from '../../source/compatibility/report.js';
import {
	captureMqtt,
	captureRest,
	dummyUsername,
	fixtureClient,
	forbidNetwork,
} from './_harness.js';

const network = forbidNetwork();
test.before(async () => {
	await ConfigManager.getInstance().initialize();
});
test.after.always(t => {
	network.restore();
	t.is(network.attempts, 0);
});

function accountIdentity(ig: IgApiClientExt) {
	return {
		deviceString: ig.state.deviceString,
		build: ig.state.build,
		deviceId: ig.state.deviceId,
		uuid: ig.state.uuid,
		phoneId: ig.state.phoneId,
		adid: ig.state.adid,
	};
}

test('owned state serializes exactly the previous fields; web UA adds no session field', async t => {
	const owned = fixtureClient();
	const original = new IgApiClientExt();
	original.state.generateDevice(dummyUsername);
	const ownedState: Record<string, unknown> = await owned.state.serialize();
	const originalState: Record<string, unknown> =
		await original.state.serialize();
	t.deepEqual(
		Object.keys(ownedState).sort(),
		Object.keys(originalState).sort(),
	);
	t.false('webUserAgent' in ownedState);
	t.false('compatibilityProfile' in ownedState);
	const restored = createInstagramApiClient();
	await restored.state.deserialize(ownedState);
	t.deepEqual(accountIdentity(restored), accountIdentity(owned));
	t.is(restored.state.webUserAgent, owned.state.webUserAgent);
});

test('normal session files retain account identity and capabilities but omit application constants', async t => {
	const before = fixtureClient();
	before.state.language = 'de_DE';
	const manager = new SessionManager('offline-profile-session');
	const serialized: Record<string, unknown> = await before.state.serialize();
	await manager.saveSession(serialized);
	const saved = await manager.loadSession();
	t.truthy(saved);
	t.false('constants' in saved!);
	t.is(saved!['capabilitiesHeader'], profile.capabilities);
	const updated = {
		...profile,
		release: {
			appVersion: '0.0.0.0.1',
			appVersionCode: '123',
			bloksVersionId: 'b'.repeat(64),
		},
		capabilities: 'AA==',
		supportedCapabilities: [{name: 'OFFLINE_ONLY', value: 1}],
		device: {...profile.device, model: 'OfflineNewDevice', build: 'NEW'},
	};
	const after = createInstagramApiClient(updated);
	generateCompatibilityDevice(after, dummyUsername, updated);
	t.not(after.state.deviceString, before.state.deviceString);
	await after.state.deserialize(saved);
	t.deepEqual(accountIdentity(after), accountIdentity(before));
	t.is(after.state.language, 'de_DE');
	t.is(after.state.appVersion, updated.release.appVersion);
	t.is(after.state.appVersionCode, updated.release.appVersionCode);
	t.is(after.state.bloksVersionId, updated.release.bloksVersionId);
	t.is(after.state.capabilitiesHeader, profile.capabilities);
	t.deepEqual(
		after.state.supportedCapabilities,
		before.state.supportedCapabilities,
	);
	t.is(
		after.state.extractCookieValue('sessionid'),
		before.state.extractCookieValue('sessionid'),
	);
	const {wire} = await captureRest(after, async () =>
		after.launcher.preLoginSync(),
	);
	const {data} = captureMqtt(after, updated);
	t.is(
		wire.headers['x-ig-capabilities'],
		data.appSpecificInfo?.['X-IG-Capabilities'],
	);
	t.is(wire.headers['user-agent'], data.clientInfo?.userAgent);
	t.false(
		compatibilityReport(after, updated).matchesSelectedProfile.capabilities,
	);
	t.false(
		compatibilityReport(after, updated).matchesSelectedProfile
			.supportedCapabilities,
	);
	await manager.deleteSession();
});

test('legacy raw constants can override the profile and split REST and MQTT app IDs', async t => {
	const ig = fixtureClient();
	const legacy: Record<string, unknown> = await ig.state.serialize();
	legacy['constants'] = {
		...ig.state.constants,
		APP_VERSION: '0.0.0.0.2',
		FACEBOOK_ANALYTICS_APPLICATION_ID: '123',
	};
	await ig.state.deserialize(legacy);
	const {wire} = await captureRest(ig, async () => ig.launcher.preLoginSync());
	const {data} = captureMqtt(ig);
	t.is(ig.state.appVersion, '0.0.0.0.2');
	t.is(wire.headers['x-ig-app-id'], '123');
	t.is(String(data.clientInfo?.appId), profile.appId);
	t.not(wire.headers['x-ig-app-id'], String(data.clientInfo?.appId));
	t.is(data.appSpecificInfo?.app_version, ig.state.appVersion);
	t.is(data.clientInfo?.userAgent, wire.headers['user-agent']);
	t.false(compatibilityReport(ig).matchesSelectedProfile.appId);
});

test('explicit post-deserialization application restores app fields without migrating devices', async t => {
	const ig = fixtureClient();
	const identity = accountIdentity(ig);
	const session: Record<string, unknown> = await ig.state.serialize();
	session['constants'] = {
		...ig.state.constants,
		APP_VERSION: '0.0.0.0.2',
		FACEBOOK_ANALYTICS_APPLICATION_ID: '123',
	};
	session['capabilitiesHeader'] = 'AA==';
	session['language'] = 'ja_JP';
	await ig.state.deserialize(session);
	applyCompatibilityProfile(ig);
	t.deepEqual(accountIdentity(ig), identity);
	t.is(ig.state.language, 'ja_JP');
	t.is(ig.state.appVersion, profile.release.appVersion);
	t.is(ig.state.capabilitiesHeader, profile.capabilities);
	t.is(ig.state.fbAnalyticsApplicationId, profile.appId);
	t.true(
		Object.values(compatibilityReport(ig).matchesSelectedProfile).every(
			Boolean,
		),
	);
	// Production deliberately does not reapply after deserialize in M1.
});

test('sanitized diagnostic excludes every account identifier and authentication value', t => {
	const ig = fixtureClient();
	ig.state.authorization = `Bearer IGT:2:${Buffer.from(JSON.stringify({ds_user_id: '123456789', sessionid: 'DO_NOT_PRINT_AUTH'})).toString('base64')}`;
	ig.state.igWWWClaim = 'DO_NOT_PRINT_CLAIM';
	ig.state.passwordEncryptionPubKey = 'DO_NOT_PRINT_ENCRYPTION_KEY';
	const report = compatibilityReport(ig);
	const text = JSON.stringify(report);
	for (const secret of [
		ig.state.deviceId,
		ig.state.uuid,
		ig.state.phoneId,
		ig.state.adid,
		ig.state.authorization,
		'DO_NOT_PRINT_AUTH',
		'DO_NOT_PRINT_CLAIM',
		'DO_NOT_PRINT_ENCRYPTION_KEY',
		'offline-only-session',
		'offline-csrf',
		'dummy-password-never-used',
		'123456789',
		dummyUsername,
	]) {
		t.false(text.includes(secret));
	}

	t.is(report.application.version, profile.release.appVersion);
	t.is(report.rest.appId, report.mqtt.appId);
	t.is(report.device.model, 'Pixel 8 Pro');
	t.is(report.profile.id, profile.id);
	t.is(report.liveValidation, 'not performed');
});

test('username seed stays case-sensitive and temporary IDs do not become stored identities', async t => {
	const ig = fixtureClient();
	const other = createInstagramApiClient();
	generateCompatibilityDevice(other, dummyUsername.toUpperCase());
	t.not(ig.state.deviceId, other.state.deviceId);
	t.not(ig.state.phoneId, other.state.phoneId);
	t.regex(ig.state.clientSessionId, /^[\da-f-]{36}$/);
	t.regex(ig.state.pigeonSessionId, /^[\da-f-]{36}$/);
	t.not(ig.state.clientSessionId, ig.state.pigeonSessionId);
	t.is(ig.state.clientSessionIdLifetime, 1_200_000);
	t.is(ig.state.pigeonSessionIdLifetime, 1_200_000);
	const state: Record<string, unknown> = await ig.state.serialize();
	t.false('clientSessionId' in state);
	t.false('pigeonSessionId' in state);
});
