import {Buffer} from 'node:buffer';
import {readFile} from 'node:fs/promises';
import test from 'ava';
import {IgApiClientExt} from 'instagram_mqtt';
import {InstagramClient} from '../../source/client.js';
import {ConfigManager} from '../../source/config.js';
import {SessionManager} from '../../source/session.js';
import {
	applyCompatibilityProfile,
	createInstagramApiClient,
	generateCompatibilityDevice,
	restoreAccountIdentity,
	restoreCompatibilitySession,
} from '../../source/compatibility/client.js';
import {legacyInheritedProfile as legacy} from '../../source/compatibility/legacy-profile.js';
import {
	currentCompatibilityProfile as profile,
	formatDeviceString,
} from '../../source/compatibility/profile.js';
import {compatibilityReport} from '../../source/compatibility/report.js';
import baseline from './_fixtures/compatibility-baseline.json' with {type: 'json'};
import {
	captureMqtt,
	captureRest,
	dummyUsername,
	fixtureClient,
	forbidNetwork,
	legacyFixtureClient,
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

/** Production order for a saved account: generate fallback, then restore. */
async function restoredClient(session: Record<string, unknown>) {
	const ig = createInstagramApiClient();
	generateCompatibilityDevice(ig, dummyUsername);
	const replaced = await restoreCompatibilitySession(ig, session);
	return {ig, replaced};
}

/** A raw state as old code or an imported file could contain it. */
async function staleSession() {
	const legacyClient = legacyFixtureClient();
	const session: Record<string, unknown> = await legacyClient.state.serialize();
	session['constants'] = {
		...legacyClient.state.constants,
		FACEBOOK_ANALYTICS_APPLICATION_ID: '123',
		SIGNATURE_KEY: 'stale-signature-key',
		EXPERIMENTS: 'stale_experiment',
		HOST: 'https://stale.invalid',
	};
	session['capabilitiesHeader'] = 'AA==';
	session['supportedCapabilities'] = [{name: 'STALE_ONLY', value: 1}];
	session['language'] = 'ja_JP';
	return {legacyClient, session};
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
	const {ig: restored} = await restoredClient(ownedState);
	t.deepEqual(accountIdentity(restored), accountIdentity(owned));
	t.is(restored.state.webUserAgent, owned.state.webUserAgent);
});

test('an M1 saved session keeps its hardware and identifiers while the profile replaces app fields', async t => {
	const before = legacyFixtureClient();
	before.state.language = 'de_DE';
	const manager = new SessionManager('offline-legacy-session');
	const serialized: Record<string, unknown> = await before.state.serialize();
	await manager.saveSession(serialized);
	const saved = await manager.loadSession();
	t.truthy(saved);
	t.false('constants' in saved!);
	t.is(saved!['deviceString'], baseline.deviceString);
	const {ig: after, replaced} = await restoredClient(saved!);
	t.deepEqual(replaced, ['supportedCapabilities']);
	t.deepEqual(accountIdentity(after), accountIdentity(before));
	t.is(after.state.deviceString, baseline.deviceString);
	t.is(after.state.build, baseline.build);
	t.is(after.state.language, 'de_DE');
	t.is(after.state.appVersion, profile.release.appVersion);
	t.is(after.state.appVersionCode, profile.release.appVersionCode);
	t.is(after.state.bloksVersionId, profile.release.bloksVersionId);
	t.is(after.state.capabilitiesHeader, profile.capabilities);
	t.deepEqual(after.state.supportedCapabilities, profile.supportedCapabilities);
	t.is(
		after.state.extractCookieValue('sessionid'),
		before.state.extractCookieValue('sessionid'),
	);
	const legacyUserAgent = `Instagram 448.0.0.0.20 Android (${baseline.deviceString}; de_DE; 1065560286)`;
	const {wire} = await captureRest(after, async () =>
		after.launcher.postLoginSync(),
	);
	const {data} = captureMqtt(after);
	t.is(wire.headers['user-agent'], legacyUserAgent);
	t.is(wire.headers['x-bloks-version-id'], profile.release.bloksVersionId);
	t.is(wire.headers['x-ig-device-id'], before.state.uuid);
	t.is(wire.headers['x-ig-android-id'], before.state.deviceId);
	t.is(data.clientInfo?.userAgent, legacyUserAgent);
	t.is(data.clientInfo?.deviceId, before.state.phoneId);
	t.is(data.appSpecificInfo?.app_version, profile.release.appVersion);
	const report = compatibilityReport(after);
	const {device, ...application} = report.matchesSelectedProfile;
	t.true(Object.values(application).every(Boolean));
	t.false(device, 'Existing hardware is reported, not silently migrated');
	await manager.deleteSession();
});

test('stale persisted constants, capabilities and supported capabilities cannot override the profile', async t => {
	const {legacyClient, session} = await staleSession();
	const pristine = new IgApiClientExt().state.constants;
	const {ig, replaced} = await restoredClient(session);
	t.deepEqual(replaced, [
		'constants',
		'capabilitiesHeader',
		'supportedCapabilities',
	]);
	t.is(ig.state.appVersion, profile.release.appVersion);
	t.is(ig.state.appVersionCode, profile.release.appVersionCode);
	t.is(ig.state.bloksVersionId, profile.release.bloksVersionId);
	t.is(ig.state.fbAnalyticsApplicationId, profile.appId);
	t.is(ig.state.signatureKey, profile.signature.key);
	t.is(ig.state.experiments, profile.experiments.join(','));
	t.is(ig.state.constants.HOST, pristine.HOST);
	t.is(ig.state.capabilitiesHeader, profile.capabilities);
	t.deepEqual(ig.state.supportedCapabilities, profile.supportedCapabilities);
	t.is(ig.state.language, 'ja_JP');
	t.deepEqual(accountIdentity(ig), accountIdentity(legacyClient));
	t.true('constants' in session && 'cookies' in session, 'Input not mutated');
	const {wire} = await captureRest(ig, async () => ig.launcher.preLoginSync());
	const {data} = captureMqtt(ig);
	t.is(wire.headers['x-ig-app-id'], profile.appId);
	t.is(String(data.clientInfo?.appId), profile.appId);
	t.is(wire.headers['x-ig-capabilities'], profile.capabilities);
	t.is(data.appSpecificInfo?.['X-IG-Capabilities'], profile.capabilities);
	t.is(data.clientInfo?.userAgent, wire.headers['user-agent']);
});

test('the raw dependency deserializer remains unsafe, so production never calls it directly', async t => {
	const {session} = await staleSession();
	const ig = fixtureClient();
	await ig.state.deserialize({...session});
	const {wire} = await captureRest(ig, async () => ig.launcher.preLoginSync());
	t.is(ig.state.appVersion, legacy.release.appVersion);
	t.is(wire.headers['x-ig-app-id'], '123');
	t.not(wire.headers['x-ig-app-id'], profile.appId);
	// A stale host even hides the session cookie from the MQTT builder.
	t.is(ig.state.constants.HOST, 'https://stale.invalid');
	t.throws(() => captureMqtt(ig), {message: /sessionid/});
	const source = await readFile(
		new URL('../../source/client.ts', import.meta.url),
		'utf8',
	);
	t.false(source.includes('state.deserialize('));
	t.true(source.includes('restoreCompatibilitySession('));
});

test('repeated profile application never regenerates account-stable identifiers', async t => {
	const {legacyClient, session} = await staleSession();
	const {ig} = await restoredClient(session);
	const identity = accountIdentity(ig);
	const otherProfile = {
		...profile,
		release: {...profile.release, appVersion: '0.0.0.0.1'},
		device: {...profile.device, model: 'OfflineOtherTemplate'},
	};
	await restoreCompatibilitySession(ig, session, otherProfile);
	applyCompatibilityProfile(ig);
	t.deepEqual(accountIdentity(ig), identity);
	t.deepEqual(identity, accountIdentity(legacyClient));
	t.is(ig.state.appVersion, profile.release.appVersion);
});

test('identity restoration for a credential login is all-or-nothing', async t => {
	const saved: Record<string, unknown> =
		await legacyFixtureClient().state.serialize();
	const ig = fixtureClient();
	const generated = accountIdentity(ig);
	for (const field of ['adid', 'deviceString'] as const) {
		const partial = {...saved, [field]: undefined};
		t.false(restoreAccountIdentity(ig, partial));
		t.deepEqual(accountIdentity(ig), generated);
	}

	t.false(restoreAccountIdentity(ig, {...saved, build: 7}));
	t.true(restoreAccountIdentity(ig, saved));
	t.deepEqual(
		accountIdentity(ig),
		accountIdentity(legacyFixtureClient()),
		'Saved identity wins over the generated new-account template',
	);
	t.is(ig.state.appVersion, profile.release.appVersion);
	t.is(ig.state.extractCookieValue('sessionid'), 'offline-only-session');
});

type ApplicationSeams = {
	preLoginFlow(): Promise<boolean>;
	postLoginSetup(username: string): Promise<void>;
};

function stubbedApplication(username?: string) {
	const application = new InstagramClient(username);
	const seams = application as unknown as ApplicationSeams;
	seams.preLoginFlow = async () => true;
	seams.postLoginSetup = async () => undefined;
	const ig = application.getInstagramClient() as IgApiClientExt;
	return {application, ig};
}

test.serial(
	'application session login restores identity and applies the profile',
	async t => {
		const username = 'offline-app-session';
		const {session, legacyClient} = await staleSession();
		await new SessionManager(username).saveSession(session);
		const {application, ig} = stubbedApplication(username);
		const result = await application.loginBySession({
			initializeRealtime: false,
		});
		t.true(result.success);
		t.deepEqual(accountIdentity(ig), accountIdentity(legacyClient));
		t.is(ig.state.appVersion, profile.release.appVersion);
		t.is(ig.state.fbAnalyticsApplicationId, profile.appId);
		t.is(ig.state.capabilitiesHeader, profile.capabilities);
		await new SessionManager(username).deleteSession();
	},
);

test.serial(
	'application credential login keeps a saved account identity',
	async t => {
		const username = 'offline-app-relogin';
		const legacyClient = legacyFixtureClient();
		const serialized: Record<string, unknown> =
			await legacyClient.state.serialize();
		await new SessionManager(username).saveSession(serialized);
		const {application, ig} = stubbedApplication();
		let atLogin: ReturnType<typeof accountIdentity> | undefined;
		// Replace only the final login request; its response is never inspected.
		Object.assign(ig.account, {
			async login() {
				atLogin = accountIdentity(ig);
				return {};
			},
		});

		const result = await application.login(username, 'dummy-password', {
			initializeRealtime: false,
		});
		t.true(result.success);
		t.deepEqual(atLogin, accountIdentity(legacyClient));
		t.is(ig.state.appVersion, profile.release.appVersion);
		await new SessionManager(username).deleteSession();
	},
);

test.serial(
	'application credential login for a new account uses the modern template',
	async t => {
		const username = 'offline-app-new-account';
		await new SessionManager(username).deleteSession();
		const {application, ig} = stubbedApplication();
		let atLogin: ReturnType<typeof accountIdentity> | undefined;
		// Replace only the final login request; its response is never inspected.
		Object.assign(ig.account, {
			async login() {
				atLogin = accountIdentity(ig);
				return {};
			},
		});

		await application.login(username, 'dummy-password', {
			initializeRealtime: false,
		});
		const expected = createInstagramApiClient();
		generateCompatibilityDevice(expected, username);
		t.deepEqual(atLogin, accountIdentity(expected));
		t.is(atLogin?.deviceString, formatDeviceString(profile.device));
		t.is(atLogin?.build, profile.device.build);
		await new SessionManager(username).deleteSession();
	},
);

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
