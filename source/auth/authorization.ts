import {Buffer} from 'node:buffer';
import type {IgApiClient} from 'instagram-private-api';

const bearerPrefix = 'Bearer IGT:2:';

export type SessionMaterialCheck =
	| {established: true; userId: string}
	| {
			established: false;
			reason: 'missing-session' | 'missing-user' | 'user-mismatch';
	  };

function bearerUserId(authorization: string | undefined): string | undefined {
	if (!authorization?.startsWith(bearerPrefix)) {
		return undefined;
	}

	try {
		const parsed: unknown = JSON.parse(
			Buffer.from(authorization.slice(bearerPrefix.length), 'base64').toString(
				'utf8',
			),
		);
		if (typeof parsed !== 'object' || parsed === null) {
			return undefined;
		}

		const {ds_user_id: userId, sessionid: sessionId} = parsed as Record<
			string,
			unknown
		>;
		if (
			(typeof userId === 'string' || typeof userId === 'number') &&
			typeof sessionId === 'string' &&
			sessionId.length > 0
		) {
			return String(userId);
		}
	} catch {}

	return undefined;
}

/**
 * The account ID carried by the client's own session material: the session
 * cookies or an IGT bearer token. A response status is never evidence of
 * authentication. Values are only compared, never logged or returned.
 */
export function sessionUserId(ig: IgApiClient): string | undefined {
	const cookieUserId = ig.state.extractCookie('ds_user_id')?.value;
	const sessionId = ig.state.extractCookie('sessionid')?.value;
	if (cookieUserId && sessionId) {
		return cookieUserId;
	}

	return bearerUserId(ig.state.authorization);
}

function responseUserId(user: unknown): string | undefined {
	if (typeof user !== 'object' || user === null) {
		return undefined;
	}

	const {pk} = user as Record<string, unknown>;
	return (typeof pk === 'string' && pk.length > 0) ||
		typeof pk === 'number' ||
		typeof pk === 'bigint'
		? String(pk)
		: undefined;
}

/**
 * Whether a completed authentication step established a session: the client
 * holds session material and, when the server described the logged-in user,
 * that user is the session's account.
 */
export function checkSessionMaterial(
	ig: IgApiClient,
	loggedInUser: unknown,
	options: {requireUser: boolean},
): SessionMaterialCheck {
	const userId = sessionUserId(ig);
	if (!userId) {
		return {established: false, reason: 'missing-session'};
	}

	const reportedUserId = responseUserId(loggedInUser);
	if (reportedUserId === undefined) {
		return options.requireUser
			? {established: false, reason: 'missing-user'}
			: {established: true, userId};
	}

	return reportedUserId === userId
		? {established: true, userId}
		: {established: false, reason: 'user-mismatch'};
}
