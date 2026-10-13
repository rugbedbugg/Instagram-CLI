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

export type ProfileStatus = 'selected' | 'legacy-reference';

/**
 * Application-level identity. These fields follow the selected profile and are
 * authoritative over anything persisted in a saved session.
 */
export type ApplicationCompatibilityProfile = {
	readonly id: string;
	readonly status: ProfileStatus;
	readonly source: string;
	readonly release: ApplicationRelease;
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
 * Captured from the Android app by instagrapi's maintainer, who reported live
 * login, reads and publishes on it (subzeroid/instagrapi#2812). Not verified
 * from an official APK; see docs/compatibility-profile.md.
 */
export const android448Release: ApplicationRelease = Object.freeze({
	appVersion: '448.0.0.0.20',
	appVersionCode: '1065560286',
	bloksVersionId:
		'0bc46a03e177bfc9bc8d611918815acf248fa9c77754d807d6a5951dc9ce9432',
});

/** Releases whose three fields are evidenced as belonging together. */
export const declaredReleases: readonly ApplicationRelease[] = Object.freeze([
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

	return Object.freeze(profile);
}

export const currentCompatibilityProfile = defineCompatibilityProfile({
	id: 'android-448.0.0.0.20-pixel-8-pro',
	status: 'selected',
	source:
		'instagrapi 3.0.24 (a3b7538) app profile 448.0.0.0.20 and device settings; build from Google factory images',
	release: android448Release,
	device: pixel8ProAndroid14,
	...inheritedApplicationConstants,
	supportedCapabilities: [
		{
			name: 'SUPPORTED_SDK_VERSIONS',
			value:
				'119.0,120.0,121.0,122.0,123.0,124.0,125.0,126.0,127.0,128.0,129.0,130.0,131.0,132.0,133.0,134.0,135.0,136.0,137.0,138.0,139.0,140.0,141.0,142.0',
		},
		{name: 'FACE_TRACKER_VERSION', value: '14'},
		{name: 'COMPRESSION', value: 'ETC2_COMPRESSION'},
		{name: 'gyroscope', value: 'gyroscope_enabled'},
	],
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
