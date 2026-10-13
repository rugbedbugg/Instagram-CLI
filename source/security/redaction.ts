/**
 * Centralized, defensive redaction for diagnostics. Structured values are
 * reduced by key before anything is serialized; the text pass below is a last
 * line of defense for strings, never the only one.
 */

const redacted = '[redacted]';

function normalizeKey(key: string): string {
	return key.toLowerCase().replaceAll(/[-_]/g, '');
}

/** Keys whose values are credentials or authentication context. */
const secretKeys = new Set(
	[
		'password',
		'enc_password',
		'new_password',
		'verification_code',
		'security_code',
		'two_factor_identifier',
		'two_factor_info',
		'sessionid',
		'csrftoken',
		'_csrftoken',
		'cookie',
		'cookies',
		'set-cookie',
		'authorization',
		'ig-set-authorization',
		'token',
		'access_token',
		'refresh_token',
		'signed_body',
		'nonce',
		'challenge_context',
		'api_path',
		'secret',
		'client_secret',
		'device_auth',
		'auth',
	].map(key => normalizeKey(key)),
);

/**
 * Keys holding whole requests or responses: their contents mix credentials
 * with everything else, so they are dropped rather than inspected.
 */
const structuralKeys = new Set(
	[
		'options',
		'request',
		'response',
		'req',
		'res',
		'jar',
		'form',
		'body',
		'headers',
		'rawHeaders',
		'socket',
		'agent',
	].map(key => normalizeKey(key)),
);

const secretKeyPattern =
	'password|enc_password|new_password|verification_code|security_code|two_factor_identifier|signed_body|_csrftoken|csrftoken|sessionid|access_token|refresh_token|token|authorization|ig-set-authorization|nonce|challenge_context';

const textRules: Array<[RegExp, string]> = [
	// IGT bearer tokens and other bearer credentials.
	[/\bbearer\s+[\w.~+/=:-]{6,}/gi, `Bearer ${redacted}`],
	// The dependency's encrypted password envelope.
	[/#PWD_INSTAGRAM[^\s"'&,;]*/g, redacted],
	// Session cookies in Cookie or Set-Cookie form.
	[
		/\b(sessionid|csrftoken|ds_user_id|rur|mid|shbid|shbts|ig_did|ig_nrcb|urlgen|datr)=("?)[^;\s"&,]*\2/gi,
		`$1=${redacted}`,
	],
	// Header lines carrying credentials.
	[
		/\b(authorization|cookie|set-cookie|ig-set-authorization|proxy-authorization)\s*:\s*[^\r\n"]*/gi,
		`$1: ${redacted}`,
	],
	// JSON members with credential names.
	[
		new RegExp(
			String.raw`"(${secretKeyPattern}|cookie|set-cookie)"\s*:\s*("(?:[^"\\]|\\.)*"|[^,}\]\s]+)`,
			'gi',
		),
		`"$1":"${redacted}"`,
	],
	// Form and query members with credential names.
	[
		new RegExp(String.raw`\b(${secretKeyPattern})=[^&\s"]*`, 'gi'),
		`$1=${redacted}`,
	],
	// Query strings may carry tokens; keep only the path.
	[/((?:https?:\/\/|\/api\/v1\/)[^\s?"'#]*)\?[^\s"'#]*/g, '$1?[query]'],
	// Challenge paths end in a per-challenge nonce.
	[/(\/challenge\/(?:reset\/|replay\/)?\d+\/)[^/\s"'?]+/g, `$1${redacted}`],
];

/** Remove credentials from free text such as messages and stack traces. */
export function redactText(text: string): string {
	let result = text;
	for (const [pattern, replacement] of textRules) {
		result = result.replace(pattern, replacement);
	}

	return result;
}

/** A request URL reduced to a loggable path: no origin, query or nonce. */
export function sanitizeRequestPath(url: string): string {
	const path = url.replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0] ?? '';
	return redactText(path === '' ? '/' : path);
}

/**
 * A copy of `value` safe to serialize: credential members are replaced,
 * request and response objects are dropped, depth and size are bounded.
 */
export function redactValue(value: unknown): unknown {
	return redactNode(value, 0, new WeakSet());
}

function redactNode(
	value: unknown,
	depth: number,
	seen: WeakSet<WeakKey>,
): unknown {
	if (typeof value === 'string') {
		return redactText(value);
	}

	if (
		value === null ||
		value === undefined ||
		typeof value === 'number' ||
		typeof value === 'boolean'
	) {
		return value;
	}

	if (typeof value === 'bigint') {
		return value.toString();
	}

	if (typeof value !== 'object') {
		return `[${typeof value}]`;
	}

	if (value instanceof Uint8Array) {
		return `[binary ${value.byteLength} bytes]`;
	}

	if (value instanceof Error) {
		return describeErrorForLog(value);
	}

	if (seen.has(value)) {
		return '[circular]';
	}

	if (depth >= 5) {
		return '[depth limit]';
	}

	seen.add(value);
	if (Array.isArray(value)) {
		return value.slice(0, 50).map(item => redactNode(item, depth + 1, seen));
	}

	const copy: Record<string, unknown> = {};
	for (const [key, member] of Object.entries(value)) {
		const normalized = normalizeKey(key);
		if (secretKeys.has(normalized)) {
			copy[key] = redacted;
		} else if (structuralKeys.has(normalized)) {
			copy[key] = '[omitted]';
		} else {
			copy[key] = redactNode(member, depth + 1, seen);
		}
	}

	return copy;
}

function stringMember(value: unknown, key: string): string | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}

	const member: unknown = (value as Record<string, unknown>)[key];
	return typeof member === 'string' ? member : undefined;
}

function httpStatus(error: unknown): number | undefined {
	if (typeof error !== 'object' || error === null) {
		return undefined;
	}

	const {response, statusCode} = error as {
		response?: unknown;
		statusCode?: unknown;
	};
	const status: unknown =
		typeof response === 'object' && response !== null
			? (response as {statusCode?: unknown}).statusCode
			: statusCode;
	return typeof status === 'number' ? status : undefined;
}

/**
 * An error as allowlisted diagnostics: class, code, HTTP status and the
 * redacted message for it and up to three causes, then stack frames. Request
 * options, responses, bodies and headers are never read.
 */
export function describeErrorForLog(error: unknown): string {
	if (!(error instanceof Error)) {
		return `Non-error value (${typeof error})`;
	}

	const lines: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current; depth++) {
		const name = stringMember(current, 'name') ?? 'Error';
		const code = stringMember(current, 'code');
		const status = httpStatus(current);
		const message = stringMember(current, 'message') ?? '';
		lines.push(
			`${depth === 0 ? '' : 'Caused by: '}${name}${code ? ` [${code}]` : ''}${
				status === undefined ? '' : ` (HTTP ${status})`
			}${message ? `: ${redactText(message)}` : ''}`,
		);
		const next: unknown =
			typeof current === 'object' && 'cause' in current
				? (current as {cause?: unknown}).cause
				: undefined;
		current = next === current ? undefined : next;
	}

	const frames = (error.stack ?? '')
		.split('\n')
		.filter(line => /^\s+at /.test(line))
		.slice(0, 15)
		.map(line => redactText(line));
	return [...lines, ...frames].join('\n');
}
