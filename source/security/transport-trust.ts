import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import process from 'node:process';

/**
 * The dependency module whose `Request.send()` builds every REST request's
 * options. Its audited patch removes the insecure `strictSSL: false` default,
 * leaving Node's certificate and hostname verification in force.
 */
export const restTransportModule = 'instagram-private-api/dist/core/request.js';

const insecureTransportDefault =
	/\bstrictSSL\s*:\s*false\b|\brejectUnauthorized\s*:\s*false\b/;

export type InsecureTransportReason = 'environment' | 'unpatched-dependency';

/** Instagram requests are refused because TLS verification would be off. */
export class InsecureTransportError extends Error {
	readonly reason: InsecureTransportReason;

	constructor(reason: InsecureTransportReason, message: string) {
		super(message);
		this.name = 'InsecureTransportError';
		this.reason = reason;
	}
}

export type TransportTrustInputs = {
	readonly environment?: NodeJS.ProcessEnv;
	/** Source of the REST transport module; defaults to the installed one. */
	readonly transportSource?: () => string;
};

const requireFromHere = createRequire(import.meta.url);
let installedTransportVerified = false;

function readInstalledTransport(): string {
	return readFileSync(requireFromHere.resolve(restTransportModule), 'utf8');
}

/**
 * Fail closed unless Instagram traffic will verify certificates: refuse a
 * process-wide verification bypass, and an installed dependency whose patch
 * was not applied (for example after `npm ci --ignore-scripts`).
 */
export function assertTransportTrust(inputs: TransportTrustInputs = {}): void {
	const environment = inputs.environment ?? process.env;
	if (environment['NODE_TLS_REJECT_UNAUTHORIZED'] === '0') {
		throw new InsecureTransportError(
			'environment',
			'NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS certificate verification, so Instagram-CLI will not connect. Unset it; to trust an additional certificate authority, use NODE_EXTRA_CA_CERTS.',
		);
	}

	const installed = inputs.transportSource === undefined;
	if (installed && installedTransportVerified) {
		return;
	}

	const source = (inputs.transportSource ?? readInstalledTransport)();
	if (insecureTransportDefault.test(source)) {
		throw new InsecureTransportError(
			'unpatched-dependency',
			'The installed instagram-private-api still disables TLS certificate verification because its patch was not applied. Reinstall dependencies with install scripts enabled (`npm ci`).',
		);
	}

	if (installed) {
		installedTransportVerified = true;
	}
}

export type TlsFailure = 'certificate' | 'hostname' | 'handshake';

// OpenSSL verification results as Node reports them in `error.code`.
const certificateFailureCodes = new Set([
	'CERT_CHAIN_TOO_LONG',
	'CERT_HAS_EXPIRED',
	'CERT_NOT_YET_VALID',
	'CERT_REJECTED',
	'CERT_REVOKED',
	'CERT_SIGNATURE_FAILURE',
	'CERT_UNTRUSTED',
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'INVALID_CA',
	'INVALID_PURPOSE',
	'PATH_LENGTH_EXCEEDED',
	'SELF_SIGNED_CERT_IN_CHAIN',
	'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
	'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
	'UNABLE_TO_GET_ISSUER_CERT',
	'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function errorCode(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null) {
		return undefined;
	}

	const {code} = error as {code?: unknown};
	return typeof code === 'string' ? code : undefined;
}

/**
 * Whether a request failed because the peer's certificate was not trusted,
 * named another host, or the TLS handshake failed. Follows the `cause` chain
 * the request library and the dependency's `IgNetworkError` wrap it in.
 */
export function classifyTlsFailure(error: unknown): TlsFailure | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current; depth++) {
		const code = errorCode(current);
		if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
			return 'hostname';
		}

		if (code !== undefined && certificateFailureCodes.has(code)) {
			return 'certificate';
		}

		if (code !== undefined && /^ERR_(TLS|SSL)_/.test(code)) {
			return 'handshake';
		}

		current =
			typeof current === 'object' && 'cause' in current
				? (current as {cause?: unknown}).cause
				: undefined;
	}

	return undefined;
}
