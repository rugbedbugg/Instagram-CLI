import type {IgApiClient} from 'instagram-private-api';

/**
 * EXPERIMENTAL. Helpers for the offline session-bootstrap experiment
 * (`source/experimental/session-bootstrap.ts`). They turn a user-authorized
 * Instagram session id — for example one copied from a logged-in browser — into
 * the cookie material the REST client sends, without claiming that the material
 * authenticates anything. Only a later authenticated private-API request can
 * establish that; see `docs/session-bootstrap.md`.
 *
 * Nothing here parses, logs or returns the session secret beyond the leading
 * account id, and the full value is only placed in the client's in-memory
 * cookie jar.
 */

/** A locally parsed session id and the account id it names. */
export type ImportedSession = {
	/** The account id carried in the session id's leading digits. */
	readonly userId: string;
	/** The verbatim session id, placed unchanged in the cookie jar. */
	readonly sessionId: string;
};

// Instagram session ids begin with the numeric account id, then a URL-encoded
// `:` (`%3A`) or a literal `:`, then the opaque token. We keep the value only
// when it has that shape and contains nothing that could break out of a cookie.
const leadingAccountId = /^(\d{1,20})(?:%3a|:)/i;
const safeCookieValue = /^[\w%.:-]+$/;
const minimumLength = 30;
const maximumLength = 1024;

/**
 * Parse a user-supplied session id, deriving the candidate account id from its
 * leading digits. Returns `undefined` for anything that is not a plausibly
 * well-formed session id; a parsed id is never evidence of authentication.
 */
export function parseImportedSessionId(
	raw: string,
): ImportedSession | undefined {
	const sessionId = raw.trim();
	if (
		sessionId.length < minimumLength ||
		sessionId.length > maximumLength ||
		!safeCookieValue.test(sessionId)
	) {
		return undefined;
	}

	const match = leadingAccountId.exec(sessionId);
	if (!match) {
		return undefined;
	}

	return {userId: match[1]!, sessionId};
}

/**
 * Place an imported session's cookies in the client's cookie jar. This loads
 * authorization material; it does not validate it. The device identity and
 * application profile must already be set on the client.
 */
export function applyImportedSession(
	ig: IgApiClient,
	imported: ImportedSession,
): void {
	const url = 'https://i.instagram.com/';
	const attributes = 'Domain=.instagram.com; Path=/';
	ig.state.cookieJar.setCookie(
		`ds_user_id=${imported.userId}; ${attributes}`,
		url,
	);
	ig.state.cookieJar.setCookie(
		`sessionid=${imported.sessionId}; ${attributes}; Secure; HttpOnly`,
		url,
	);
}
