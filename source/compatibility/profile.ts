import data from './baseline-data.json' with {type: 'json'};

export type AndroidDeviceProfile = {
	readonly androidSdk: number;
	readonly androidRelease: string;
	readonly dpi: string;
	readonly resolution: string;
	readonly manufacturer: string;
	readonly model: string;
	readonly device: string;
	readonly cpu: string;
};

/** One concrete device, including the OS build it reports. */
export type AndroidDeviceTemplate = AndroidDeviceProfile & {
	readonly build: string;
};

export type SupportedCapability =
	| {readonly name: string; readonly value: string}
	| {readonly name: string; readonly value: number};

/**
 * App version, build number and Bloks version identify one application build.
 * They are declared together and must never be changed independently.
 */
export type ApplicationRelease = {
	readonly appVersion: string;
	readonly appVersionCode: string;
	readonly bloksVersionId: string;
};

export type ProfileStatus =
	| 'selected'
	| 'historical-reference'
	| 'legacy-reference';

/**
 * What is known about a profile. `offline` is this project's own harness
 * result; `liveLogin` is never claimed from offline evidence.
 */
export type ProfileEvidence = {
	readonly summary: string;
	readonly offline: 'verified-coherent' | 'inconsistent';
	readonly liveLogin:
		| 'unverified'
		| 'historical-success-later-failing'
		| 'known-failing';
};

/**
 * Application-level identity. These fields follow the selected profile and are
 * authoritative over anything persisted in a saved session.
 */
export type ApplicationCompatibilityProfile = {
	readonly id: string;
	readonly status: ProfileStatus;
	readonly source: string;
	readonly evidence: ProfileEvidence;
	readonly release: ApplicationRelease;
	/** Lowest Android API level that can install the release. */
	readonly minimumAndroidSdk: number;
	readonly appId: string;
	readonly capabilities: string;
	readonly webChromeVersion: string;
	readonly defaultLanguage: string;
	readonly signature: {
		readonly version: string;
		readonly key: string;
		readonly breadcrumbKey: string;
	};
	readonly supportedCapabilities: readonly SupportedCapability[];
	readonly experiments: readonly string[];
	readonly loginExperiments: readonly string[];
	readonly realtime: {
		readonly clientCapabilities: number;
		readonly endpointCapabilities: number;
		readonly publishFormat: number;
		readonly clientStack: number;
	};
};

/** A selectable profile: application identity plus the device for new accounts. */
export type InstagramCompatibilityProfile = ApplicationCompatibilityProfile & {
	readonly device: AndroidDeviceTemplate;
};

/**
 * Current maintained-client default (subzeroid/instagrapi#2855): the runtime
 * User-Agent build and API Bloks version of the current Android app, not its
 * manifest versionCode. Not verified from an official APK.
 */
export const android449Release: ApplicationRelease = Object.freeze({
	appVersion: '449.0.0.52.84',
	appVersionCode: '1079242191',
	bloksVersionId:
		'799db3e387d7a21a19c72918b8698b6cd28a1516ade363792c100ed45a0f9f0b',
});

/**
 * Historical: captured with reported live login (subzeroid/instagrapi#2812),
 * later reproduced as needs_upgrade on fresh clients (#2807).
 */
export const android448Release: ApplicationRelease = Object.freeze({
	appVersion: '448.0.0.0.20',
	appVersionCode: '1065560286',
	bloksVersionId:
		'0bc46a03e177bfc9bc8d611918815acf248fa9c77754d807d6a5951dc9ce9432',
});

/** Releases whose three fields are evidenced as belonging together. */
export const declaredReleases: readonly ApplicationRelease[] = Object.freeze([
	android449Release,
	android448Release,
]);

export function isDeclaredRelease(release: ApplicationRelease): boolean {
	return declaredReleases.some(
		declared =>
			declared.appVersion === release.appVersion &&
			declared.appVersionCode === release.appVersionCode &&
			declared.bloksVersionId === release.bloksVersionId,
	);
}

/**
 * Pixel 8 Pro hardware as paired with the release by instagrapi. Resolution and
 * the final global Android 14 build come from Google's published specifications.
 */
export const pixel8ProAndroid14: AndroidDeviceTemplate = Object.freeze({
	androidSdk: 34,
	androidRelease: '14',
	dpi: '480dpi',
	resolution: '1344x2992',
	manufacturer: 'Google/google',
	model: 'Pixel 8 Pro',
	device: 'husky',
	cpu: 'husky',
	build: 'AP2A.240905.003',
});

/** Values that no evidence ties to a newer generation; kept deliberately. */
export const inheritedApplicationConstants = {
	appId: '567067343352427',
	capabilities: '3brTv10=',
	webChromeVersion: '131.0.6778.135',
	defaultLanguage: 'en_US',
	signature: {
		version: '4',
		key: '9193488027538fd3450b83b7d05286d4ca9599a0f7eeed90d8c85925698a05dc',
		breadcrumbKey: 'iN4$aGr0m',
	},
	experiments: data.experiments,
	loginExperiments: data.loginExperiments,
	realtime: {
		clientCapabilities: 183,
		endpointCapabilities: 0,
		publishFormat: 1,
		clientStack: 3,
	},
} as const satisfies Partial<ApplicationCompatibilityProfile>;

export function defineCompatibilityProfile(
	profile: InstagramCompatibilityProfile,
): InstagramCompatibilityProfile {
	if (!isDeclaredRelease(profile.release)) {
		throw new Error(
			`Profile ${profile.id} mixes app version, version code and Bloks version from different releases`,
		);
	}

	if (profile.device.androidSdk < profile.minimumAndroidSdk) {
		throw new Error(
			`Profile ${profile.id} pairs its release with a device that cannot install it`,
		);
	}

	return Object.freeze(profile);
}

/** Supported capabilities sent by the maintained client with both profiles. */
const maintainedClientSupportedCapabilities: readonly SupportedCapability[] = [
	{
		name: 'SUPPORTED_SDK_VERSIONS',
		value:
			'119.0,120.0,121.0,122.0,123.0,124.0,125.0,126.0,127.0,128.0,129.0,130.0,131.0,132.0,133.0,134.0,135.0,136.0,137.0,138.0,139.0,140.0,141.0,142.0',
	},
	{name: 'FACE_TRACKER_VERSION', value: '14'},
	{name: 'COMPRESSION', value: 'ETC2_COMPRESSION'},
	{name: 'gyroscope', value: 'gyroscope_enabled'},
];

export const currentCompatibilityProfile = defineCompatibilityProfile({
	id: 'android-449.0.0.52.84-pixel-8-pro',
	status: 'selected',
	source:
		'instagrapi 3.0.24 (a3b7538) default app profile 449.0.0.52.84 and device settings; build from Google factory images',
	evidence: {
		summary: 'captured current Android profile (maintained-client default)',
		offline: 'verified-coherent',
		liveLogin: 'unverified',
	},
	release: android449Release,
	// APK indexes list Android 9.0+ for every 293–450 build; not APK-verified.
	minimumAndroidSdk: 28,
	device: pixel8ProAndroid14,
	...inheritedApplicationConstants,
	supportedCapabilities: maintainedClientSupportedCapabilities,
});

/** The M2 first selection, kept as evidence. Never used for new accounts. */
export const android448HistoricalProfile = defineCompatibilityProfile({
	id: 'android-448.0.0.0.20-pixel-8-pro',
	status: 'historical-reference',
	source:
		'instagrapi 3.0.24 (a3b7538) app profile 448.0.0.0.20 and device settings; build from Google factory images',
	evidence: {
		summary:
			'captured Android profile; reported live login, later fresh-client needs_upgrade',
		offline: 'verified-coherent',
		liveLogin: 'historical-success-later-failing',
	},
	release: android448Release,
	minimumAndroidSdk: 28,
	device: pixel8ProAndroid14,
	...inheritedApplicationConstants,
	supportedCapabilities: maintainedClientSupportedCapabilities,
});

export function formatDeviceString(device: AndroidDeviceProfile): string {
	return [
		`${device.androidSdk}/${device.androidRelease}`,
		device.dpi,
		device.resolution,
		device.manufacturer,
		device.model,
		device.device,
		device.cpu,
	].join('; ');
}
