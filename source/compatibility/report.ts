import type {IgApiClient} from 'instagram-private-api';
import {
	currentCompatibilityProfile,
	type InstagramCompatibilityProfile,
} from './profile.js';

/** Allowlisted identity fields only. Does not load sessions or construct requests. */
export function compatibilityReport(
	ig: IgApiClient,
	profile: InstagramCompatibilityProfile = currentCompatibilityProfile,
) {
	const {state} = ig;
	const [android, dpi, resolution, manufacturer, model] =
		state.deviceString.split('; ');
	return {
		project: 'Instagram-CLI',
		liveValidation: 'not performed',
		application: {
			version: state.appVersion,
			versionCode: state.appVersionCode,
			bloksVersionId: state.bloksVersionId,
			capabilities: state.capabilitiesHeader,
			signatureVersion: state.signatureVersion,
			supportedCapabilityCount: state.supportedCapabilities.length,
		},
		device: {android, dpi, resolution, manufacturer, model, build: state.build},
		locale: state.language,
		rest: {appId: state.fbAnalyticsApplicationId},
		mqtt: {appId: profile.appId, ...profile.realtime},
		matchesSelectedProfile: {
			appVersion: state.appVersion === profile.appVersion,
			appVersionCode: state.appVersionCode === profile.appVersionCode,
			bloksVersionId: state.bloksVersionId === profile.bloksVersionId,
			appId: state.fbAnalyticsApplicationId === profile.appId,
			capabilities: state.capabilitiesHeader === profile.capabilities,
			supportedCapabilities:
				JSON.stringify(state.supportedCapabilities) ===
				JSON.stringify(profile.supportedCapabilities),
		},
	};
}
