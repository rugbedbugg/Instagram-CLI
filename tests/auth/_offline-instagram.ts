import {Buffer} from 'node:buffer';
import {generateKeyPairSync} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {STATUS_CODES} from 'node:http';
import {PassThrough} from 'node:stream';
import type {IgApiClient} from 'instagram-private-api';
import {
	createInstagramApiClient,
	generateCompatibilityDevice,
} from '../../source/compatibility/client.js';

/**
 * Deterministic Instagram stand-in for authentication tests. It replaces only
 * the socket layer beneath the `request` library, so the dependency's real
 * signing, cookie jar, response parsing, `end$`/`error$` events and error
 * classes all run. Every request must match the next scripted step; nothing
 * ever reaches a socket.
 */

export const syntheticPassword = 'synthetic-password-7f3c91';
export const syntheticCode = '913782';
export const syntheticUserId = '5550001';
export const syntheticSessionId = 'synthetic-sessionid-a1b2c3';
export const previousSessionId = 'previous-sessionid-d4e5f6';
export const syntheticTwoFactorIdentifier = 'synthetic-2fa-identifier';

export type ScriptedResponse = {
	status: number;
	body: unknown;
	headers?: Record<string, string | string[]>;
};

export type ScriptedStep = {
	method: 'GET' | 'POST';
	path: string;
	respond: ScriptedResponse | {networkError: string};
};

export type RecordedRequest = {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: string;
};

// Disposable key so the dependency's real password encryption runs offline.
const {publicKey} = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: {type: 'spki', format: 'pem'},
	privateKeyEncoding: {type: 'pkcs8', format: 'pem'},
});

// The request library drives its transport through Node's EventEmitter API.
// eslint-disable-next-line unicorn/prefer-event-target
class FakeClientRequest extends EventEmitter {
	private readonly chunks: Uint8Array[] = [];
	private readonly onEnd: (body: string) => void;

	constructor(onEnd: (body: string) => void) {
		super();
		this.onEnd = onEnd;
	}

	write(chunk: string | Uint8Array): boolean {
		this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
		return true;
	}

	end(chunk?: string | Uint8Array): void {
		if (chunk) {
			this.write(chunk);
		}

		setImmediate(() => {
			this.onEnd(Buffer.concat(this.chunks).toString('utf8'));
		});
	}

	setTimeout(): this {
		return this;
	}

	abort(): void {}
	destroy(): void {}
}

export class ScriptedInstagram {
	readonly requests: RecordedRequest[] = [];
	readonly unexpected: string[] = [];
	private readonly steps: ScriptedStep[] = [];

	constructor(ig: IgApiClient) {
		const transport = {
			request: (options: {
				method: string;
				path: string;
				headers: Record<string, string | number>;
				body?: string;
			}) => {
				const request = new FakeClientRequest(written => {
					this.answer(
						request,
						options,
						written.length > 0 ? written : (options.body ?? ''),
					);
				});
				return request;
			},
		};
		const offlineDefaults = {
			httpModules: {'https:': transport, 'http:': transport},
			pool: false as const,
			proxy: null,
		};
		ig.request.defaults = offlineDefaults;
	}

	expect(...steps: ScriptedStep[]): this {
		this.steps.push(...steps);
		return this;
	}

	get pending(): number {
		return this.steps.length;
	}

	requestsTo(path: string): RecordedRequest[] {
		return this.requests.filter(request => request.path === path);
	}

	private answer(
		request: FakeClientRequest,
		options: {
			method: string;
			path: string;
			headers: Record<string, string | number>;
		},
		body: string,
	): void {
		const path = options.path.split('?')[0]!;
		this.requests.push({
			method: options.method,
			path,
			headers: Object.fromEntries(
				Object.entries(options.headers).map(([name, value]) => [
					name.toLowerCase(),
					String(value),
				]),
			),
			body,
		});
		const step = this.steps[0];
		if (step?.method !== options.method || step.path !== path) {
			this.unexpected.push(`${options.method} ${path}`);
			request.emit('error', new Error('Unscripted offline request'));
			return;
		}

		this.steps.shift();
		if ('networkError' in step.respond) {
			request.emit(
				'error',
				Object.assign(new Error('Synthetic transport failure'), {
					code: step.respond.networkError,
				}),
			);
			return;
		}

		const {status, body: responseBody, headers = {}} = step.respond;
		const response = Object.assign(new PassThrough(), {
			statusCode: status,
			statusMessage: STATUS_CODES[status],
			headers: Object.fromEntries(
				Object.entries(headers).map(([name, value]) => [
					name.toLowerCase(),
					value,
				]),
			),
		});
		request.emit('response', response);
		response.end(
			typeof responseBody === 'string'
				? responseBody
				: JSON.stringify(responseBody),
		);
	}
}

const cookie = (name: string, value: string) =>
	`${name}=${value}; Domain=.instagram.com; Path=/; Secure; HttpOnly`;

export const ok = (
	body: Record<string, unknown> = {},
	headers?: Record<string, string | string[]>,
): ScriptedResponse => ({status: 200, body: {status: 'ok', ...body}, headers});

export const step = (
	method: 'GET' | 'POST',
	path: string,
	respond: ScriptedStep['respond'],
): ScriptedStep => ({method, path, respond});

export const loggedInUser = (username: string) => ({
	pk: Number(syntheticUserId),
	pk_id: syntheticUserId,
	username,
	full_name: 'Synthetic Account',
});

/** Requests the existing credential flow makes before its login submission. */
export const preLogin = (): ScriptedStep[] => [
	step(
		'POST',
		'/api/v1/launcher/sync/',
		ok({}, {'set-cookie': [cookie('csrftoken', 'synthetic-csrf')]}),
	),
	step(
		'POST',
		'/api/v1/qe/sync/',
		ok(
			{},
			{
				'ig-set-password-encryption-key-id': '41',
				'ig-set-password-encryption-pub-key':
					Buffer.from(publicKey).toString('base64'),
			},
		),
	),
];

export const sessionCookies = (sessionId = syntheticSessionId) => [
	cookie('ds_user_id', syntheticUserId),
	cookie('sessionid', sessionId),
	cookie('csrftoken', 'synthetic-csrf-authenticated'),
];

export const loginAccepted = (username: string): ScriptedStep =>
	step(
		'POST',
		'/api/v1/accounts/login/',
		ok(
			{logged_in_user: loggedInUser(username)},
			{'set-cookie': sessionCookies()},
		),
	);

export const loginRejected = (body: Record<string, unknown>, status = 400) =>
	step('POST', '/api/v1/accounts/login/', {
		status,
		body: {status: 'fail', ...body},
	});

/** Requests the existing post-login flow makes once a session is established. */
export const postLogin = (): ScriptedStep[] => [
	step('POST', '/api/v1/feed/reels_tray/', ok({tray: []})),
	step('POST', '/api/v1/feed/timeline/', ok({feed_items: []})),
];

/** A synthetic previously saved, authenticated session for `username`. */
export async function previousSession(
	username: string,
): Promise<Record<string, unknown>> {
	const ig = createInstagramApiClient();
	generateCompatibilityDevice(ig, `previous:${username}`);
	for (const value of sessionCookies(previousSessionId)) {
		ig.state.cookieJar.setCookie(value, 'https://i.instagram.com/');
	}

	const {constants, ...serialized} = (await ig.state.serialize()) as Record<
		string,
		unknown
	>;
	return serialized;
}
