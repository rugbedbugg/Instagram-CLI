import {Buffer} from 'node:buffer';
import test from 'ava';
import {safeDebugLine} from '../../source/security/debug-diagnostics.js';
import {
	describeErrorForLog,
	redactText,
	redactValue,
	sanitizeRequestPath,
} from '../../source/security/redaction.js';

const secret = 'marker-secret-5d1f';

for (const [name, text] of [
	['a bearer token', `Authorization: Bearer IGT:2:${secret}`],
	['an IGT token without a header', `token Bearer IGT:2:${secret}`],
	[
		'an encrypted password',
		`enc_password=#PWD_INSTAGRAM:4:1700000000:${secret}`,
	],
	['a session cookie', `Cookie: sessionid=${secret}; csrftoken=${secret}`],
	['a Set-Cookie value', `sessionid="${secret}"; Domain=.instagram.com`],
	['a JSON credential member', `{"two_factor_identifier":"${secret}"}`],
	['a numeric JSON credential member', `{"verification_code":${secret}}`],
	['a form credential member', `username=a&password=${secret}&x=1`],
	[
		'a query string',
		`GET https://i.instagram.com/api/v1/feed/?token=${secret}`,
	],
	['a challenge nonce', `POST /api/v1/challenge/reset/5550001/${secret}/`],
] as Array<[string, string]>) {
	test(`redactText removes ${name}`, t => {
		t.false(redactText(text).includes(secret));
	});
}

test('redactText keeps ordinary diagnostics', t => {
	const text =
		'POST /api/v1/accounts/login/ - 400 Bad Request; IgLoginBadPasswordError (HTTP 400) ECONNRESET';
	t.is(redactText(text), text);
});

test('sanitizeRequestPath keeps only a nonce-free path', t => {
	t.is(
		sanitizeRequestPath(
			`https://i.instagram.com/api/v1/challenge/5550001/${secret}/?guid=${secret}`,
		),
		'/api/v1/challenge/5550001/[redacted]/',
	);
	t.is(sanitizeRequestPath('/api/v1/feed/timeline/'), '/api/v1/feed/timeline/');
});

test('redactValue drops credential and request members by key', t => {
	const circular: Record<string, unknown> = {name: 'loop'};
	circular['self'] = circular;
	const value = redactValue({
		status: 404,
		password: secret,
		Authorization: secret,
		'Set-Cookie': [secret],
		two_factor_info: {two_factor_identifier: secret},
		options: {form: {enc_password: secret}},
		response: {body: secret},
		nested: {deeper: {token: secret, kept: 'visible'}},
		bytes: Buffer.from(secret),
		circular,
		message: `failed with sessionid=${secret}`,
	});
	const serialized = JSON.stringify(value);
	t.false(serialized.includes(secret));
	t.regex(serialized, /"kept":"visible"/);
	t.regex(serialized, /"status":404/);
	t.regex(serialized, /"options":"\[omitted]"/);
	t.regex(serialized, /\[circular]/);
	t.regex(serialized, /\[binary \d+ bytes]/);
});

test('redactValue bounds depth', t => {
	let deep: Record<string, unknown> = {value: secret.replace('secret', 'leaf')};
	for (let level = 0; level < 10; level++) {
		deep = {deep};
	}

	t.regex(JSON.stringify(redactValue(deep)), /\[depth limit]/);
});

test('describeErrorForLog reads allowlisted fields only', t => {
	const error = Object.assign(new Error('request failed'), {
		name: 'IgResponseError',
		code: 'E_SYNTHETIC',
		options: {headers: {Authorization: `Bearer ${secret}`}},
		response: {
			statusCode: 403,
			body: {secret},
			headers: {'set-cookie': [secret]},
		},
		cause: Object.assign(new Error(`inner sessionid=${secret}`), {
			code: 'ECONNRESET',
		}),
	});
	const described = describeErrorForLog(error);
	t.false(described.includes(secret));
	t.regex(
		described,
		/^IgResponseError \[E_SYNTHETIC] \(HTTP 403\): request failed\nCaused by: Error \[ECONNRESET]: inner sessionid=\[redacted]/,
	);
	t.regex(described, /\n\s+at /);
});

test('describeErrorForLog survives a cause cycle', t => {
	const error = new Error('outer');
	(error as {cause?: unknown}).cause = error;
	t.notThrows(() => describeErrorForLog(error));
});

test('safeDebugLine keeps reviewed messages and withholds the rest', t => {
	t.is(
		safeDebugLine('ig:request', 'Requesting POST /api/v1/accounts/login/'),
		'ig:request: Requesting POST /api/v1/accounts/login/',
	);
	t.is(
		safeDebugLine(
			'ig:request',
			`Request POST /api/v1/accounts/login/ failed: {"message":"${secret}"}`,
		),
		'ig:request: Request POST /api/v1/accounts/login/ failed (response body withheld)',
	);
	t.is(
		safeDebugLine('ig:state', 'Could not find ds_user_id'),
		'ig:state: Could not find ds_user_id',
	);
	for (const [namespace, message] of [
		[
			'ig:account',
			`Login failed, two factor auth required: {"id":"${secret}"}`,
		],
		['ig:state', `Could not parse authorization: SyntaxError ${secret}`],
		['ig:mqtt:fbns', `Received auth: ${secret}`],
		['mqtt:client:packet', `CONNECT ${secret}`],
		['ig:upload', `Initializing video upload: {"x":"${secret}"}`],
		[undefined, secret],
	] as Array<[string | undefined, string]>) {
		t.false(safeDebugLine(namespace, message).includes(secret));
	}

	t.is(
		safeDebugLine('ig:upload', `Initializing video upload: ${secret}`),
		`ig:upload: message withheld (${`Initializing video upload: ${secret}`.length} chars)`,
	);
});
