import data from './baseline-data.json' with {type: 'json'};
import {
	inheritedApplicationConstants,
	type AndroidDeviceProfile,
	type ApplicationCompatibilityProfile,
	type ApplicationRelease,
} from './profile.js';

/**
 * The M1 identity inherited from patched instagram-private-api 1.46.1. Its
 * release fields were never evidenced as one build. Reference only: it is never
 * used to construct a new account.
 */
export const legacyInheritedRelease: ApplicationRelease = Object.freeze({
	appVersion: '416.0.0.47.66',
	appVersionCode: '382206157',
	bloksVersionId:
		'388ece79ebc0e70e87873505ed1b0ff335ae2868a978cc951b6721c41d46a30a',
});

export type LegacyInheritedProfile = ApplicationCompatibilityProfile & {
	readonly devices: readonly AndroidDeviceProfile[];
	// Independent build selection, including duplicate entries.
	readonly builds: readonly string[];
};

export const legacyInheritedProfile: LegacyInheritedProfile = Object.freeze({
	id: 'legacy-inherited-416.0.0.47.66',
	status: 'legacy-reference',
	source:
		'instagram-private-api 1.46.1 samples and constants with the removed version patch (M1 baseline)',
	release: legacyInheritedRelease,
	...inheritedApplicationConstants,
	supportedCapabilities: data.supportedCapabilities,
	devices: data.devices,
	builds: data.builds,
});
