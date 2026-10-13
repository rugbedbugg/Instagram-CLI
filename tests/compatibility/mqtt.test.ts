import {Buffer} from 'node:buffer';
import {inflateSync} from 'node:zlib';
import test from 'ava';
import {
	Commands,
	FbnsClient,
	GraphQLSubscriptions,
	SkywalkerSubscriptions,
	type MQTToTClient,
	type MQTToTConnection,
} from 'instagram_mqtt';
import {compressDeflate} from 'instagram_mqtt/dist/shared.js';
import {
	currentCompatibilityProfile as profile,
	formatDeviceString,
	type InstagramCompatibilityProfile,
} from '../../source/compatibility/profile.js';
import {legacyInheritedProfile as legacy} from '../../source/compatibility/legacy-profile.js';
import identity from './_fixtures/compatibility-baseline.json' with {type: 'json'};
import {
	captureMqtt,
	captureRest,
	dummySession,
	dummyUserId,
	fixtureClient,
	forbidNetwork,
	legacyFixtureClient,
} from './_harness.js';

const network = forbidNetwork();
test.after.always(t => {
	network.restore();
	t.is(network.attempts, 0, 'No MQTT or other network transport was opened');
});

// The Thrift reader represents wire i64 values as {int, num}, not the input
// Int64 union. Its generic result type does not express that transformation.
function decodedInt(value: unknown): bigint {
	if (
		typeof value === 'object' &&
		value !== null &&
		'int' in value &&
		typeof value.int === 'bigint'
	) {
		return value.int;
	}

	throw new Error('Expected a decoded Thrift i64');
}

test('legacy reference MQTT connection and Thrift preserve the M1 fingerprint', async t => {
	const ig = legacyFixtureClient();
	const {data, decoded, thrift, realtime} = captureMqtt(ig, legacy);
	t.is(realtime.mqtt, undefined);
	t.is(String(data.clientInfo?.appId), identity.mqtt.appId);
	t.is(data.clientInfo?.clientCapabilities, identity.mqtt.clientCapabilities);
	t.is(
		data.clientInfo?.endpointCapabilities,
		identity.mqtt.endpointCapabilities,
	);
	t.is(data.clientInfo?.clientStack, identity.mqtt.clientStack);
	t.is(data.clientInfo?.publishFormat, identity.mqtt.publishFormat);
	t.deepEqual(data.clientInfo?.subscribeTopics, identity.mqtt.subscribeTopics);
	t.deepEqual(data.appSpecificInfo, identity.mqtt.appSpecificInfo);
	t.deepEqual(decoded.appSpecificInfo, data.appSpecificInfo);
	t.is(decoded.clientInfo?.userAgent, identity.appUserAgent);
	t.is(decodedInt(decoded.clientInfo?.appId), BigInt(identity.appId));
	t.is(decodedInt(decoded.clientInfo?.clientCapabilities), 183n);
	t.is(decodedInt(decoded.clientInfo?.endpointCapabilities), 0n);
	t.is(decoded.clientInfo?.clientStack, 3);
	t.is(decoded.clientInfo?.publishFormat, 1);
	t.deepEqual(
		decoded.clientInfo?.subscribeTopics,
		identity.mqtt.subscribeTopics,
	);
	t.deepEqual(inflateSync(await compressDeflate(thrift)), thrift);
});

const selectedUserAgent =
	'Instagram 448.0.0.0.20 Android (34/14; 480dpi; 1344x2992; Google/google; Pixel 8 Pro; husky; husky; en_US; 1065560286)';

test('selected profile reaches MQTT connection data and serialized Thrift', async t => {
	const ig = fixtureClient();
	const {data, decoded, thrift} = captureMqtt(ig);
	t.deepEqual(data.appSpecificInfo, {
		...identity.mqtt.appSpecificInfo,
		app_version: '448.0.0.0.20',
		'User-Agent': selectedUserAgent,
	});
	t.deepEqual(decoded.appSpecificInfo, data.appSpecificInfo);
	t.is(data.clientInfo?.userAgent, selectedUserAgent);
	t.is(decoded.clientInfo?.userAgent, selectedUserAgent);
	t.is(decodedInt(decoded.clientInfo?.appId), 567_067_343_352_427n);
	t.is(decodedInt(decoded.clientInfo?.clientCapabilities), 183n);
	t.is(decodedInt(decoded.clientInfo?.endpointCapabilities), 0n);
	t.is(decoded.clientInfo?.clientStack, 3);
	t.is(decoded.clientInfo?.publishFormat, 1);
	t.is(decoded.clientInfo?.deviceId, ig.state.phoneId);
	t.is(decoded.clientIdentifier, ig.state.phoneId.slice(0, 20));
	t.deepEqual(inflateSync(await compressDeflate(thrift)), thrift);
	const serialized = Buffer.from(thrift).toString('latin1');
	t.true(serialized.includes(selectedUserAgent));
	for (const marker of [
		identity.appVersion,
		identity.appVersionCode,
		'MI MAX 2',
	]) {
		t.false(serialized.includes(marker), `No legacy ${marker}`);
	}
});

test('REST and MQTT present one identity for the selected profile', async t => {
	const ig = fixtureClient();
	const launcher = await captureRest(ig, async () =>
		ig.launcher.postLoginSync(),
	);
	const timeline = await captureRest(ig, async () =>
		ig.feed.timeline('cold_start_fetch').request(),
	);
	const {data, decoded} = captureMqtt(ig);
	for (const {wire} of [launcher, timeline]) {
		t.is(wire.headers['user-agent'], data.clientInfo?.userAgent);
		t.is(wire.headers['user-agent'], data.appSpecificInfo?.['User-Agent']);
		t.is(wire.headers['x-ig-app-id'], String(data.clientInfo?.appId));
		t.is(
			wire.headers['x-ig-capabilities'],
			data.appSpecificInfo?.['X-IG-Capabilities'],
		);
		t.is(
			wire.headers['accept-language'],
			data.appSpecificInfo?.['Accept-Language'],
		);
		t.true(
			wire.headers['user-agent']!.startsWith(
				`Instagram ${data.appSpecificInfo?.app_version} Android (`,
			),
		);
	}

	// Device relationships: REST binds UUID/device ID, MQTT binds phone ID.
	t.is(timeline.form.get('phone_id'), ig.state.phoneId);
	t.is(data.clientInfo?.deviceId, ig.state.phoneId);
	t.is(decoded.clientInfo?.deviceId, ig.state.phoneId);
	t.is(launcher.payload['_uuid'], ig.state.uuid);
	t.is(String(launcher.payload['_uid']), String(data.clientInfo?.userId));
	t.is(data.password, `sessionid=${dummySession}`);
});

test('MQTT account and ephemeral identity fields have their inherited relationships', t => {
	const ig = fixtureClient();
	const {data, decoded} = captureMqtt(ig);
	t.is(data.clientIdentifier, ig.state.phoneId.slice(0, 20));
	t.is(data.clientInfo?.deviceId, ig.state.phoneId);
	t.not(data.clientInfo?.deviceId, ig.state.deviceId);
	t.is(data.clientInfo?.userId, BigInt(dummyUserId));
	t.is(decodedInt(decoded.clientInfo?.userId), BigInt(dummyUserId));
	t.is(data.password, `sessionid=${dummySession}`);
	t.is(decoded.password, data.password);
	t.is(decoded.clientIdentifier, data.clientIdentifier);
	t.is(decoded.clientInfo?.deviceId, ig.state.phoneId);
	const session = decodedInt(decoded.clientInfo?.clientMqttSessionId);
	t.true(session >= 0n && session <= 0xff_ff_ff_ffn);
	t.is(data.clientInfo?.clientType, 'cookie_auth');
	t.is(data.clientInfo?.networkType, 1);
	t.is(data.clientInfo?.networkSubtype, 0);
	t.is(data.clientInfo?.deviceSecret, '');
	t.false(data.clientInfo?.noAutomaticForeground);
	t.true(data.clientInfo?.makeUserAvailableInForeground);
	t.true(data.clientInfo?.isInitiallyForeground);
});

test('MQTT preserves the inherited Number conversion boundary for large user IDs', t => {
	const ig = fixtureClient();
	ig.state.cookieJar.setCookie(
		'ds_user_id=9007199254740993; Domain=.instagram.com; Path=/',
		'https://i.instagram.com/',
	);
	const {data} = captureMqtt(ig);
	t.is(ig.state.cookieUserId, '9007199254740993');
	t.is(data.clientInfo?.userId, 9_007_199_254_740_992n);
});

test('an unparsed authorization header leaves MQTT using the existing cookie', t => {
	const ig = fixtureClient();
	ig.state.authorization = `Bearer IGT:2:${Buffer.from(JSON.stringify({ds_user_id: dummyUserId, sessionid: 'offline-authorization-session'})).toString('base64')}`;
	const {data} = captureMqtt(ig);
	t.is(data.password, `sessionid=${dummySession}`);
	t.is(ig.state.parsedAuthorization, undefined);
});

test('authorization-only MQTT needs the lazy authorization parser primed first', t => {
	const ig = fixtureClient(profile, false);
	ig.state.authorization = `Bearer IGT:2:${Buffer.from(JSON.stringify({ds_user_id: dummyUserId, sessionid: 'offline-authorization-session'})).toString('base64')}`;
	t.throws(() => captureMqtt(ig), {message: /sessionid/});
	t.is(ig.state.cookieUserId, dummyUserId);
	const {data} = captureMqtt(ig);
	t.is(data.password, 'sessionid=offline-authorization-session');
});

test('a cached authorization session can lag a changed REST authorization header', t => {
	const ig = fixtureClient(profile, false);
	const authorization = (sessionid: string) =>
		`Bearer IGT:2:${Buffer.from(JSON.stringify({ds_user_id: dummyUserId, sessionid})).toString('base64')}`;
	ig.state.authorization = authorization('offline-old-session');
	t.is(ig.state.cookieUserId, dummyUserId);
	ig.state.authorization = authorization('offline-new-session');
	const {data} = captureMqtt(ig);
	t.is(data.password, 'sessionid=offline-old-session');
	t.is(ig.state.parsedAuthorization?.sessionid, 'offline-new-session');
});

const profileChanges: Array<[string, Partial<InstagramCompatibilityProfile>]> =
	[
		[
			'application release',
			{
				release: {
					appVersion: '0.0.0.0.1',
					appVersionCode: '123',
					bloksVersionId: 'a'.repeat(64),
				},
			},
		],
		['application ID', {appId: '123456789'}],
		['capabilities', {capabilities: 'AA=='}],
		[
			'device inputs',
			{
				device: {
					...profile.device,
					model: 'OfflineFixtureModel',
					build: 'OFFLINE_BUILD',
				},
			},
		],
		['locale', {defaultLanguage: 'fr_FR'}],
		[
			'MQTT client capabilities',
			{
				realtime: {
					...profile.realtime,
					clientCapabilities: 184,
					endpointCapabilities: 1,
				},
			},
		],
	];
for (const [name, change] of profileChanges) {
	test(`changing ${name} reaches every applicable REST/MQTT builder`, async t => {
		const selected = {...profile, ...change};
		const ig = fixtureClient(selected);
		const {wire} = await captureRest(ig, async () =>
			ig.launcher.preLoginSync(),
		);
		const {data, decoded} = captureMqtt(ig, selected);
		t.is(wire.headers['x-ig-app-id'], selected.appId);
		t.is(String(data.clientInfo?.appId), selected.appId);
		t.is(decodedInt(decoded.clientInfo?.appId), BigInt(selected.appId));
		t.is(wire.headers['x-bloks-version-id'], selected.release.bloksVersionId);
		t.is(wire.headers['x-ig-capabilities'], selected.capabilities);
		t.is(data.appSpecificInfo?.['X-IG-Capabilities'], selected.capabilities);
		t.is(data.appSpecificInfo?.app_version, selected.release.appVersion);
		t.is(data.clientInfo?.userAgent, wire.headers['user-agent']);
		t.is(data.appSpecificInfo?.['User-Agent'], wire.headers['user-agent']);
		t.is(
			data.appSpecificInfo?.['Accept-Language'],
			wire.headers['accept-language'],
		);
		t.is(
			wire.headers['user-agent'],
			`Instagram ${selected.release.appVersion} Android (${ig.state.deviceString}; ${selected.defaultLanguage}; ${selected.release.appVersionCode})`,
		);
		t.is(
			decodedInt(decoded.clientInfo?.clientCapabilities),
			BigInt(selected.realtime.clientCapabilities),
		);
		t.is(
			decodedInt(decoded.clientInfo?.endpointCapabilities),
			BigInt(selected.realtime.endpointCapabilities),
		);
		t.is(ig.state.deviceString, formatDeviceString(selected.device));
		t.is(ig.state.build, selected.device.build);
	});
}

test('Iris subscription carries the selected application version', async t => {
	const {realtime} = captureMqtt(fixtureClient());
	let payload: Uint8Array | undefined;
	const transport = {
		async publish(packet: {payload: Uint8Array}) {
			payload = packet.payload;
		},
	};
	realtime.commands = new Commands(transport as unknown as MQTToTClient);
	await realtime.irisSubscribe({seq_id: 3, snapshot_at_ms: 4});
	t.deepEqual(JSON.parse(inflateSync(payload!).toString()), {
		seq_id: 3,
		snapshot_at_ms: 4,
		snapshot_app_version: '448.0.0.0.20',
	});
});

test('Iris subscription uses the same application version through real compression', async t => {
	const selected = {
		...profile,
		release: {...profile.release, appVersion: '0.0.0.0.1'},
	};
	const {realtime} = captureMqtt(fixtureClient(selected), selected);
	let published:
		| {payload: Uint8Array; topic: string; qosLevel: number}
		| undefined;
	// Only the final publish operation is replaced; Commands encodes/compresses.
	const transport = {
		async publish(packet: NonNullable<typeof published>) {
			published = packet;
		},
	};
	realtime.commands = new Commands(transport as unknown as MQTToTClient);
	await realtime.irisSubscribe({seq_id: 1, snapshot_at_ms: 2});
	t.truthy(published);
	t.is(published!.topic, '134');
	t.is(published!.qosLevel, 1);
	t.deepEqual(JSON.parse(inflateSync(published!.payload).toString()), {
		seq_id: 1,
		snapshot_at_ms: 2,
		snapshot_app_version: selected.release.appVersion,
	});
});

test('subscription builders retain query identity and only reference synthetic accounts', t => {
	const ig = fixtureClient();
	const subscriptions = [
		[GraphQLSubscriptions.getAppPresenceSubscription(), '17846944882223835'],
		[
			GraphQLSubscriptions.getZeroProvisionSubscription(ig.state.phoneId),
			'17913953740109069',
		],
		[GraphQLSubscriptions.getDirectStatusSubscription(), '17854499065530643'],
		[
			GraphQLSubscriptions.getDirectTypingSubscription(dummyUserId),
			'17867973967082385',
		],
		[
			GraphQLSubscriptions.getAsyncAdSubscription(dummyUserId),
			'17911191835112000',
		],
	];
	for (const [subscription, queryId] of subscriptions) {
		t.true(subscription!.startsWith(`1/graphqlsubscriptions/${queryId}/`));
		const input = (
			JSON.parse(subscription!.slice(subscription!.indexOf('{'))) as {
				input_data: Record<string, string>;
			}
		).input_data;
		t.is(
			input['client_subscription_id'] === undefined,
			queryId === '17867973967082385',
		);
		t.regex(
			input['client_subscription_id'] ?? '00000000-0000-0000-0000-000000000000',
			/^[\da-f-]{36}$/,
		);
		t.is(
			input['device_id'],
			queryId === '17913953740109069' ? ig.state.phoneId : undefined,
		);
		t.is(
			input['user_id'],
			['17867973967082385', '17911191835112000'].includes(queryId!)
				? dummyUserId
				: undefined,
		);
	}

	t.is(SkywalkerSubscriptions.directSub(dummyUserId), `ig/u/v1/${dummyUserId}`);
	t.is(
		SkywalkerSubscriptions.liveSub(dummyUserId),
		`ig/live_notification_subscribe/${dummyUserId}`,
	);
});

test('unused FBNS has separate hard-coded identity, explicitly outside the active adapter', t => {
	const fbns = new FbnsClient(fixtureClient());
	const builder = fbns as unknown as {
		conn: MQTToTConnection;
		buildConnection(): void;
	};
	builder.buildConnection();
	const {clientInfo} = builder.conn.fbnsConnectionData;
	t.is(String(clientInfo?.appId), '567310203415052');
	t.not(String(clientInfo?.appId), profile.appId);
	t.is(clientInfo?.clientCapabilities, 183);
	t.is(clientInfo?.endpointCapabilities, 128);
	t.is(clientInfo?.clientType, 'device_auth');
	t.deepEqual(clientInfo?.subscribeTopics, [76, 80, 231]);
	t.true(
		clientInfo?.userAgent?.includes(
			`FBAV/${profile.release.appVersion};FBBV/${profile.release.appVersionCode}`,
		),
	);
	t.true(clientInfo?.userAgent?.includes('FBDM/{density=4.0,'));
	t.true(clientInfo?.userAgent?.includes('FBCA/x86:armeabi-v7a'));
});
