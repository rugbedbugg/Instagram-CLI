import {Buffer} from 'node:buffer';
import {createHash, generateKeyPairSync} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {
	RealtimeClient,
	MQTToTConnection,
	thriftReadToObject,
	type IgApiClientExt,
	type MQTToTConnectionData,
	type RealtimeClientInitOptions,
} from 'instagram_mqtt';
import Chance from 'chance';
import {
	createInstagramApiClient,
	generateCompatibilityDevice,
	realtimeCompatibilityOptions,
} from '../../source/compatibility/client.js';
import {
	legacyInheritedProfile,
	type LegacyInheritedProfile,
} from '../../source/compatibility/legacy-profile.js';
import {
	currentCompatibilityProfile,
	formatDeviceString,
	type ApplicationCompatibilityProfile,
	type InstagramCompatibilityProfile,
} from '../../source/compatibility/profile.js';

export const dummyUsername = 'offline-profile-fixture';
export const dummyPassword = 'dummy-password-never-used';
export const dummyUserId = '123456789';
export const dummySession = 'offline-only-session';
export const hash = (value: string): string =>
	createHash('sha256').update(value).digest('hex');

/** Fail closed in this AVA worker, including any accidentally missed transport. */
export function forbidNetwork() {
	let attempts = 0;
	const deny = (): never => {
		attempts++;
		throw new Error('Network forbidden in compatibility tests');
	};

	const original = {
		socketConnect: net.Socket.prototype.connect,
		tlsConnect: tls.connect,
		httpRequest: http.request,
		httpsRequest: https.request,
		fetch: globalThis.fetch,
	};
	net.Socket.prototype.connect = deny;
	tls.connect = deny;
	http.request = deny;
	https.request = deny;
	globalThis.fetch = deny;
	return {
		get attempts() {
			return attempts;
		},
		restore() {
			net.Socket.prototype.connect = original.socketConnect;
			tls.connect = original.tlsConnect;
			http.request = original.httpRequest;
			https.request = original.httpsRequest;
			globalThis.fetch = original.fetch;
		},
	};
}

function addDummyCookies(ig: IgApiClientExt): void {
	for (const cookie of [
		`ds_user_id=${dummyUserId}`,
		`sessionid=${dummySession}`,
		'csrftoken=offline-csrf',
	]) {
		ig.state.cookieJar.setCookie(
			`${cookie}; Domain=.instagram.com; Path=/`,
			'https://i.instagram.com/',
		);
	}
}

/** A new account under the given selectable profile. */
export function fixtureClient(
	profile: InstagramCompatibilityProfile = currentCompatibilityProfile,
	withCookies = true,
): IgApiClientExt {
	const ig = createInstagramApiClient(profile);
	generateCompatibilityDevice(ig, dummyUsername, profile);
	ig.state.timezoneOffset = '0';
	if (withCookies) {
		addDummyCookies(ig);
	}

	return ig;
}

/**
 * Test-only replica of the M1 username-seeded pool generator. Production never
 * generates legacy devices; old hardware only arrives from a saved session.
 */
export function generateLegacyDevice(
	ig: IgApiClientExt,
	seed: string,
	profile: LegacyInheritedProfile = legacyInheritedProfile,
): void {
	const chance = new Chance(seed);
	ig.state.deviceString = formatDeviceString(
		chance.pickone([...profile.devices]),
	);
	ig.state.deviceId = `android-${chance.string({pool: 'abcdef0123456789', length: 16})}`;
	ig.state.uuid = chance.guid();
	ig.state.phoneId = chance.guid();
	ig.state.adid = chance.guid();
	ig.state.build = chance.pickone([...profile.builds]);
}

/** The complete M1 inherited identity: legacy application fields and device. */
export function legacyFixtureClient(withCookies = true): IgApiClientExt {
	const ig = createInstagramApiClient(legacyInheritedProfile);
	generateLegacyDevice(ig, dummyUsername);
	ig.state.timezoneOffset = '0';
	if (withCookies) {
		addDummyCookies(ig);
	}

	return ig;
}

// The real encryption path consumes a locally generated disposable public key.
// No credential, cookie, private key, or encrypted password enters a fixture.
const {publicKey} = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: {type: 'spki', format: 'pem'},
	privateKeyEncoding: {type: 'pkcs8', format: 'pem'},
});
export function prepareLoginEncryption(ig: IgApiClientExt): void {
	ig.state.passwordEncryptionPubKey = Buffer.from(publicKey).toString('base64');
	ig.state.passwordEncryptionKeyId = 1;
}

type WireRequest = {
	path: string;
	method: string;
	headers: Record<string, string>;
	body: string;
};

/** Run repositories, signing, request defaults, and request's form encoder. */
export async function captureRest(
	ig: IgApiClientExt,
	construct: () => Promise<unknown>,
) {
	const captured: WireRequest[] = [];
	const stop = 'OFFLINE_CAPTURE_BEFORE_SOCKET';
	const transport = {
		request(
			options: Omit<WireRequest, 'headers'> & {
				headers: Record<string, string | number>;
			},
		): never {
			captured.push({
				path: options.path,
				method: options.method,
				headers: Object.fromEntries(
					Object.entries(options.headers).map(([name, value]) => [
						name.toLowerCase(),
						String(value),
					]),
				),
				body: options.body,
			});
			throw new Error(stop);
		},
	};
	const original = ig.request.defaults;
	const offlineDefaults = {
		httpModules: {'https:': transport, 'http:': transport},
		pool: false as const,
		proxy: null,
	};
	ig.request.defaults = offlineDefaults;
	try {
		await construct();
		throw new Error('Expected the offline transport to stop construction');
	} catch (error) {
		if (!(error instanceof Error) || !error.message.includes(stop)) {
			throw error;
		}
	} finally {
		ig.request.defaults = original;
	}

	if (captured.length !== 1) {
		throw new Error(
			`Expected one offline request, captured ${captured.length}`,
		);
	}

	const wire = captured[0]!;
	const form = new URLSearchParams(wire.body);
	const signed = form.get('signed_body');
	const signedJson = signed?.slice(signed.indexOf('.') + 1);
	const payload = (
		signedJson ? JSON.parse(signedJson) : Object.fromEntries(form)
	) as Record<string, unknown>;
	return {wire, form, payload, signedJson};
}

// Private methods are accessed only in the test harness. Calling connect()
// would create a transport; this seam exercises the actual preceding builder.
type OfflineRealtime = {
	connection: MQTToTConnection;
	setInitOptions(options: RealtimeClientInitOptions): void;
	constructConnection(): void;
};

export function captureMqtt(
	ig: IgApiClientExt,
	profile: ApplicationCompatibilityProfile = currentCompatibilityProfile,
) {
	const realtime = new RealtimeClient(ig, []);
	const builder = realtime as unknown as OfflineRealtime;
	builder.setInitOptions(realtimeCompatibilityOptions(profile));
	builder.constructConnection();
	const thrift = builder.connection.toThrift();
	const decoded = thriftReadToObject<MQTToTConnectionData>(
		thrift,
		MQTToTConnection.thriftConfig,
	);
	return {
		realtime,
		data: builder.connection.fbnsConnectionData,
		decoded,
		thrift,
	};
}
