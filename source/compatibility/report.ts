import type {IgApiClient} from 'instagram-private-api';
import {
	currentCompatibilityProfile,
	formatDeviceString,
	type InstagramCompatibilityProfile,
} from './profile.js';

/** Allowlisted identity fields only. Does not load sessions or construct requests. */
export function compatibilityReport(
	ig: IgApiClient,
	profile: InstagramCompatibilityProfile = currentCompatibilityProfile,
) {
	const {state} = ig;
	const [android = '', dpi, resolution, manufacturer, model, codename, cpu] =
		state.deviceString.split('; ');
	const [androidSdk, androidRelease] = android.split('/');
	return {
		project: 'Instagram-CLI',
		liveValidation: 'not performed',
		profile: {
			id: profile.id,
			status: profile.status,
			source: profile.source,
			minimumAndroidSdk: profile.minimumAndroidSdk,
		},
		application: {
			version: state.appVersion,
			versionCode: state.appVersionCode,
			bloksVersionId: state.bloksVersionId,
			capabilities: state.capabilitiesHeader,
			signatureVersion: state.signatureVersion,
			supportedCapabilityCount: state.supportedCapabilities.length,
		},
		device: {
			androidRelease,
			androidSdk,
			dpi,
			resolution,
			manufacturer,
			model,
			codename,
			cpu,
			build: state.build,
			// A retained legacy device may predate the selected app's minimum.
			meetsAppMinimum: Number(androidSdk) >= profile.minimumAndroidSdk,
		},
		locale: state.language,
		rest: {appId: state.fbAnalyticsApplicationId},
		// MQTT reads app version and UA from the same state as REST.
		mqtt: {
			appId: profile.appId,
			appVersion: state.appVersion,
			...profile.realtime,
		},
		matchesSelectedProfile: {
			appVersion: state.appVersion === profile.release.appVersion,
			appVersionCode: state.appVersionCode === profile.release.appVersionCode,
			bloksVersionId: state.bloksVersionId === profile.release.bloksVersionId,
			appId: state.fbAnalyticsApplicationId === profile.appId,
			capabilities: state.capabilitiesHeader === profile.capabilities,
			supportedCapabilities:
				JSON.stringify(state.supportedCapabilities) ===
				JSON.stringify(profile.supportedCapabilities),
			// False for an existing account that keeps its saved hardware.
			device:
				state.deviceString === formatDeviceString(profile.device) &&
				state.build === profile.device.build,
		},
	};
}

export type CompatibilityReport = ReturnType<typeof compatibilityReport>;

/** Developer-readable rendering of the same allowlisted fields. */
export function formatCompatibilityReport(report: CompatibilityReport): string {
	const {profile, application, device, rest, mqtt} = report;
	const mismatches = Object.entries(report.matchesSelectedProfile)
		.filter(([, matches]) => !matches)
		.map(([field]) => field);
	const rows: Array<[string, string]> = [
		['Profile', profile.id],
		['Profile status', profile.status],
		['Profile source', profile.source],
		['App version', application.version],
		['Version code', application.versionCode],
		['Bloks version', application.bloksVersionId],
		['Android', `${device.androidRelease} (SDK ${device.androidSdk})`],
		[
			'Device',
			`${device.manufacturer} ${device.model} (${device.codename}; ${device.cpu}; ${device.dpi}; ${device.resolution}; build ${device.build})`,
		],
		[
			'App minimum',
			`SDK ${profile.minimumAndroidSdk} (${device.meetsAppMinimum ? 'met' : 'not met by this device'})`,
		],
		['REST app ID', rest.appId],
		['REST capabilities', application.capabilities],
		['MQTT app version', mqtt.appVersion],
		['MQTT app ID', mqtt.appId],
		[
			'Matches profile',
			mismatches.length === 0 ? 'yes' : `no: ${mismatches.join(', ')}`,
		],
		['Live validation', report.liveValidation],
	];
	return [
		'Instagram-CLI compatibility profile',
		'',
		...rows.map(([label, value]) => `${`${label}:`.padEnd(20)}${value}`),
	].join('\n');
}
