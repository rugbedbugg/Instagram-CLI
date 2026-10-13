import Chance from 'chance';
import type {IgApiClient} from 'instagram-private-api';
import {IgApiClientExt, type RealtimeClientInitOptions} from 'instagram_mqtt';
import {
	currentCompatibilityProfile,
	formatDeviceString,
	type ApplicationCompatibilityProfile,
	type InstagramCompatibilityProfile,
} from './profile.js';

/** Apply application fields only; never regenerate an account's device IDs. */
export function applyCompatibilityProfile(
	ig: IgApiClient,
	profile: ApplicationCompatibilityProfile = currentCompatibilityProfile,
): void {
	const {release} = profile;
	// The dependency declares historical constants as literal types even though
	// its state intentionally supports replacement at runtime. Clone per client.
	const constants = {
		...ig.state.constants,
		APP_VERSION: release.appVersion,
		APP_VERSION_CODE: release.appVersionCode,
		BLOKS_VERSION_ID: release.bloksVersionId,
		FACEBOOK_ANALYTICS_APPLICATION_ID: profile.appId,
		SIGNATURE_VERSION: profile.signature.version,
		SIGNATURE_KEY: profile.signature.key,
		BREADCRUMB_KEY: profile.signature.breadcrumbKey,
		EXPERIMENTS: profile.experiments.join(','),
		LOGIN_EXPERIMENTS: profile.loginExperiments.join(','),
	};
	ig.state.constants = constants as typeof ig.state.constants;
	ig.state.capabilitiesHeader = profile.capabilities;
	ig.state.supportedCapabilities = profile.supportedCapabilities.map(entry => ({
		...entry,
	}));
	// There is no setter for the web UA. Override only this instance's accessor,
	// without serializing a new field or changing the dependency's prototype.
	Object.defineProperty(ig.state, 'webUserAgent', {
		configurable: true,
		enumerable: false,
		get: () =>
			`Mozilla/5.0 (Linux; Android ${ig.state.devicePayload.android_release}; ${ig.state.devicePayload.model} Build/${ig.state.build}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${profile.webChromeVersion} Mobile Safari/537.36 ${ig.state.appUserAgent}`,
	});
}

export function createInstagramApiClient(
	profile: ApplicationCompatibilityProfile = currentCompatibilityProfile,
): IgApiClientExt {
	const ig = new IgApiClientExt();
	applyCompatibilityProfile(ig, profile);
	ig.state.language = profile.defaultLanguage;
	return ig;
}

/**
 * New-account identity: the profile's one fixed device template, plus
 * identifiers derived deterministically from the case-sensitive username.
 */
export function generateCompatibilityDevice(
	ig: IgApiClient,
	seed: string,
	profile: InstagramCompatibilityProfile = currentCompatibilityProfile,
): void {
	const chance = new Chance(seed);
	ig.state.deviceString = formatDeviceString(profile.device);
	ig.state.build = profile.device.build;
	ig.state.deviceId = `android-${chance.string({pool: 'abcdef0123456789', length: 16})}`;
	ig.state.uuid = chance.guid();
	ig.state.phoneId = chance.guid();
	ig.state.adid = chance.guid();
}

/** Persisted per-account identity that an application profile never replaces. */
export const accountIdentityFields = [
	'deviceString',
	'build',
	'deviceId',
	'uuid',
	'phoneId',
	'adid',
] as const;

/**
 * Restore a saved account's device identity, all or nothing, without its
 * authentication state. Used before a fresh credential login.
 */
export function restoreAccountIdentity(
	ig: IgApiClient,
	saved: Record<string, unknown>,
): boolean {
	const values = accountIdentityFields.map(field => saved[field]);
	if (!values.every(value => typeof value === 'string' && value.length > 0)) {
		return false;
	}

	for (const [index, field] of accountIdentityFields.entries()) {
		ig.state[field] = values[index] as string;
	}

	return true;
}

/**
 * Restore a saved session, then make the application profile authoritative.
 * Returns the saved application-level fields that the profile replaced.
 */
export async function restoreCompatibilitySession(
	ig: IgApiClient,
	session: Record<string, unknown>,
	profile: ApplicationCompatibilityProfile = currentCompatibilityProfile,
): Promise<string[]> {
	const replaced = [
		'constants' in session && 'constants',
		'capabilitiesHeader' in session &&
			session['capabilitiesHeader'] !== profile.capabilities &&
			'capabilitiesHeader',
		'supportedCapabilities' in session &&
			JSON.stringify(session['supportedCapabilities']) !==
				JSON.stringify(profile.supportedCapabilities) &&
			'supportedCapabilities',
	].filter(field => typeof field === 'string');
	// Persisted constants are never trusted: they would also replace dependency
	// hosts and OTA fields. Copy first; the dependency deletes deserialized keys.
	const restorable = {...session};
	delete restorable['constants'];
	await ig.state.deserialize(restorable);
	applyCompatibilityProfile(ig, profile);
	return replaced;
}

/** Override the supported MQTT fields instead of patching its compiled code. */
export function realtimeCompatibilityOptions(
	profile: ApplicationCompatibilityProfile = currentCompatibilityProfile,
): Pick<RealtimeClientInitOptions, 'connectOverrides'> {
	return {
		connectOverrides: {
			appId: BigInt(profile.appId),
			...profile.realtime,
		},
	};
}
