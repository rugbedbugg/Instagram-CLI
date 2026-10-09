import test from 'ava';
import {
	IgApiClientExt,
	RealtimeClient,
	type RealtimeClientInitOptions,
} from 'instagram_mqtt';
import {InstagramClient} from '../../source/client.js';
import {
	generateCompatibilityDevice,
	realtimeCompatibilityOptions,
} from '../../source/compatibility/client.js';
import {currentCompatibilityProfile as profile} from '../../source/compatibility/profile.js';
import {dummyUsername, forbidNetwork} from './_harness.js';

const network = forbidNetwork();
test.after.always(t => {
	network.restore();
	t.is(network.attempts, 0);
});

test.serial(
	'application constructs the owned client and passes its MQTT overrides at integration',
	async t => {
		const application = new InstagramClient();
		const ig = application.getInstagramClient();
		t.true(
			ig instanceof IgApiClientExt,
			'withRealtime must retain the configured instance',
		);
		t.is(ig.state.appVersion, profile.appVersion);
		t.is(ig.state.appVersionCode, profile.appVersionCode);
		t.is(ig.state.bloksVersionId, profile.bloksVersionId);
		generateCompatibilityDevice(ig, dummyUsername);
		ig.state.cookieJar.setCookie(
			'ds_user_id=123456789; Domain=.instagram.com; Path=/',
			'https://i.instagram.com/',
		);
		// Exercise the application's integration method, intercepting both of its
		// external boundaries. Other tests exercise the real MQTT builder itself.
		const inbox = () => ({
			async request() {
				return {seq_id: 1, snapshot_at_ms: 2};
			},
		});
		ig.feed.directInbox = inbox as unknown as typeof ig.feed.directInbox;
		const original = RealtimeClient.prototype.connect;
		let captured: RealtimeClientInitOptions | undefined;
		RealtimeClient.prototype.connect = options => {
			if (Array.isArray(options))
				throw new Error('Expected structured MQTT options');
			captured = options;
			throw new Error('OFFLINE_APPLICATION_CONNECT_BOUNDARY');
		};

		try {
			const integration = application as unknown as {
				initializeRealtime(): Promise<void>;
			};
			await t.throwsAsync(integration.initializeRealtime(), {
				message: 'OFFLINE_APPLICATION_CONNECT_BOUNDARY',
			});
		} finally {
			RealtimeClient.prototype.connect = original;
		}

		t.deepEqual(
			captured?.connectOverrides,
			realtimeCompatibilityOptions().connectOverrides,
		);
		t.deepEqual(captured?.irisData, {seq_id: 1, snapshot_at_ms: 2});
		t.is(captured?.graphQlSubs?.length, 5);
		t.is(captured?.skywalkerSubs?.length, 2);
	},
);
