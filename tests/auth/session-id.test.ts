import test from 'ava';
import {sessionUserId} from '../../source/auth/authorization.js';
import {
	applyImportedSession,
	parseImportedSessionId,
} from '../../source/auth/session-id.js';
import {createInstagramApiClient} from '../../source/compatibility/client.js';

const userId = '5550001';
const token = 'AbCdEf0123456789AbCdEf0123456789xyz';
const browserSession = `${userId}%3A${token}%3A27%3AabcdEF-0`;
const decodedSession = `${userId}:${token}:27:abcdEF-0`;

test('a browser session id yields its leading account id verbatim', t => {
	const parsed = parseImportedSessionId(browserSession);
	t.deepEqual(parsed, {userId, sessionId: browserSession});
});

test('surrounding whitespace is trimmed but the token is left intact', t => {
	const parsed = parseImportedSessionId(`  ${browserSession}\n`);
	t.deepEqual(parsed, {userId, sessionId: browserSession});
});

test('a session id with a literal colon separator is accepted', t => {
	const parsed = parseImportedSessionId(decodedSession);
	t.deepEqual(parsed, {userId, sessionId: decodedSession});
});

for (const [name, value] of [
	['an empty string', ''],
	['whitespace only', '   \t  '],
	['too short to be a session id', '5550001%3Ashort'],
	['no leading account id', `abc%3A${token}%3A27%3Aabcd`],
	['leading id without a separator', `5550001${token}`],
	['a value carrying a cookie delimiter', `${userId}%3A${token}; Path=/`],
	['a value carrying whitespace', `${userId}%3A${token} and more`],
	['a value carrying a newline', `${userId}%3A${token}\nSet-Cookie: x=y`],
] as const) {
	test(`${name} is rejected`, t => {
		t.is(parseImportedSessionId(value), undefined);
	});
}

test('applying an imported session makes it the client session material', t => {
	const ig = createInstagramApiClient();
	t.is(sessionUserId(ig), undefined);

	applyImportedSession(ig, {userId, sessionId: browserSession});

	// The account id comes from the cookies the imported session set, not from
	// any server response.
	t.is(sessionUserId(ig), userId);
	t.is(ig.state.extractCookie('sessionid')?.value, browserSession);
});
