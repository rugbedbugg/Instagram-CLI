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

export type SupportedCapability =
	| {readonly name: string; readonly value: string}
	| {readonly name: string; readonly value: number};

/** An observed baseline, not a claim of acceptance by Instagram. */
export type InstagramCompatibilityProfile = {
	readonly appVersion: string;
	readonly appVersionCode: string;
	readonly bloksVersionId: string;
	readonly appId: string;
	readonly capabilities: string;
	readonly webChromeVersion: string;
	readonly defaultLanguage: string;
	readonly signature: {
		readonly version: string;
		readonly key: string;
		readonly breadcrumbKey: string;
	};
	readonly devices: readonly AndroidDeviceProfile[];
	// Preserve independent build selection, including duplicate entries.
	readonly builds: readonly string[];
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

export const currentCompatibilityProfile: InstagramCompatibilityProfile = {
	appVersion: '416.0.0.47.66',
	appVersionCode: '382206157',
	bloksVersionId:
		'388ece79ebc0e70e87873505ed1b0ff335ae2868a978cc951b6721c41d46a30a',
	appId: '567067343352427',
	capabilities: '3brTv10=',
	webChromeVersion: '131.0.6778.135',
	defaultLanguage: 'en_US',
	signature: {
		version: '4',
		key: '9193488027538fd3450b83b7d05286d4ca9599a0f7eeed90d8c85925698a05dc',
		breadcrumbKey: 'iN4$aGr0m',
	},
	devices: data.devices,
	builds: data.builds,
	supportedCapabilities: data.supportedCapabilities,
	experiments: data.experiments,
	loginExperiments: data.loginExperiments,
	realtime: {
		clientCapabilities: 183,
		endpointCapabilities: 0,
		publishFormat: 1,
		clientStack: 3,
	},
};

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
