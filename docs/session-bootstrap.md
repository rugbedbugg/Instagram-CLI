# Session bootstrap (experimental investigation)

> **This is an experiment, not a supported way to log in.** It exists to answer
> one question offline and, later, with one explicitly authorized live test:
> _can an existing, user-authorized Instagram session authenticate private
> mobile-API requests from this client?_ Nothing here establishes that it does.
> No Instagram request, MQTT connection or login attempt has been made.

Related: [Authentication and session integrity](authentication.md),
[Compatibility profile](compatibility-profile.md),
[Transport trust](transport-security.md). Background and the decision to run a
narrow experiment are in the M3c assessment.

## 1. Why this exists

Credential login through the legacy `accounts/login/` endpoint is refused for
accounts Instagram routes to its current CAA/Bloks login, and that flow depends
on device-integrity signals this project does not reproduce. The one path that
needs no synthesized integrity state is reuse of a session the user is already
authorized to hold. This experiment builds the smallest implementation needed
to test that path, and nothing more. It does **not** implement CAA, Bloks or
device attestation, and it does not add a general authentication-backend
abstraction.

## 2. Four things that are easy to conflate

| Stage                               | What it is                                                                                                                             | What it is **not**                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Previously saved mobile session** | A `session.ts.json` this CLI wrote after an accepted login. Restored by `loginBySession()`.                                            | Not necessarily still valid; Instagram may have revoked it.                                                                                |
| **Browser-originated session**      | A `sessionid` cookie copied from a logged-in web browser. The input to this experiment.                                                | Not a mobile session; the mobile API may reject it. Upstream evidence is contradictory (section 5).                                        |
| **Parsed authorization material**   | The account id derived from a session id's leading digits, plus the cookie loaded into the client.                                     | **Not authentication.** A locally parsed id proves nothing about the server.                                                               |
| **Server-validated authentication** | An authenticated private-API request (`accounts/current_user/`) that both succeeds and names the account the session material carries. | The only stage this experiment treats as success. A public GraphQL response, or any HTTP 200 without the matching account, does not count. |

## 3. Lifecycle

```text
session id (no-echo input, in memory only)
        │  parseImportedSessionId: shape check, derive candidate account id
        ▼
candidate {userId, sessionId}        (undefined → no-session/unusable, no request)
        │  generateCompatibilityDevice(seed = session-bootstrap:<userId>)
        │  applyImportedSession: load ds_user_id + sessionid cookies
        ▼
client holds session material        (absent → no-session/unusable)
        │  validateImportedSession: ONE GET /api/v1/accounts/current_user/
        ▼
checkSessionMaterial(user, requireUser: true)
        │  established AND server names this account → validated
        ▼
persist (SessionManager + SessionPersistence), then post-login cold start
        ▼
session-validated {username}
```

Every non-validated branch returns a typed outcome and writes nothing:
`no-session`, `session-expired` (`login_required`), `incompatible-response`
(`user-mismatch`, `missing-user`, `malformed-response`), `network-error`,
`untrusted-connection`, `checkpoint-required`, `rate-limited`.

## 4. Boundaries this experiment keeps

- **No success without the server.** Only `session-validated` counts; it needs an
  authenticated private-API request that names the session's own account.
- **No persistence before validation.** The session file is written only after
  the server validates the session, under the account the server named, not the
  one the session id claimed.
- **No secret leaves memory.** The session id is read with the terminal echo
  off, never passed on the command line, and never written to logs, errors,
  outcomes or test snapshots. Only the leading account id is ever parsed out.
- **No access to existing saved sessions.** The bootstrap never scans the users
  directory to harvest a device or cookies. It derives a **new** device from the
  session's account id, so a bootstrap presents as a new device.
- **No retries, no fallback.** One validation request per attempt; it never
  falls back to credential login, and it never drives a challenge.
- **Identity stays fixed.** It uses the accepted Instagram 449 profile and does
  not change M2's migration policy, the app identity or the HTTP transport.
- **Unverified until the server says so.** The account is treated as unknown
  until `current_user` establishes it.

### Known incompatibility, not worked around

Because the bootstrap presents a freshly generated Android 14 device, and a
browser session was established on entirely different hardware, Instagram may
treat it as a new device and raise a checkpoint. Separately, M2 notes that a
retained legacy Android 6–8 device combined with Instagram 449 is a combination
no real phone can produce. This experiment does not invent a workaround for
either; it surfaces whatever the server returns and stops.

## 5. Contradictory upstream evidence for browser-session reuse

Whether a browser `sessionid` authenticates the private mobile API is **not
settled**:

- instagrapi ships `login_by_sessionid()` and reports it as usable, setting the
  `sessionid` cookie and deriving the user id the same way (pinned `62f962e`).
- The upstream `instagram-cli` maintainer reported that browser-cookie login
  "does not work" on the mobile API (issue #254, 2026-03-08).
- Reports in instagrapi #2852 note that a **previously saved instagrapi
  session** keeps working while fresh logins fail — but that is a saved mobile
  session, not a browser one.

The offline tests here prove only that our flow is correct and safe; they do not
show that a browser session works. That is exactly what the live test would
decide.

## 6. Account-security consequences to expect

A live attempt touches a real account and may:

- raise a **new-device checkpoint** or "Was this you?" review, because the device
  is new;
- **revoke the browser session** being imported, logging the account out of the
  browser;
- trigger **rate limiting** or an account-protection response.

Use only a dedicated test account you control, and stop on the first such
response.

## 7. Running the offline entry point

`source/experimental/session-bootstrap.ts` is a manual tool. It is **not** a
Pastel command, is **not** part of the shipped `dist` bundle, and is not an
enabled authentication method. Run it directly, with a dedicated test account's
session id and an isolated data directory:

```bash
INSTAGRAM_CLI_HOME="$(mktemp -d)" \
  node --loader ts-node/esm source/experimental/session-bootstrap.ts
```

The input is hidden. It prints a sanitized outcome and exits; it makes at most
one validation request (plus the normal post-login cold start only on success),
never polls and never retries.

## 8. Precise live-validation procedure (requires separate approval)

Do not run this without explicit, separate authorization. When authorized:

1. **Account and storage.** A dedicated test account you control. A fresh
   `INSTAGRAM_CLI_HOME`. Hash the real `~/.instagram-cli` before and after; it
   must be untouched.
2. **Protections on.** TLS verification on; `NODE_TLS_REJECT_UNAUTHORIZED` unset;
   no intercepting proxy; built from a pinned commit with `npm ci` so the M3b
   guard is active.
3. **One attempt.** Obtain the `sessionid` from a browser logged into the test
   account. Run the entry point once. No loops, no second attempt the same day.
4. **Record only.** Outcome kind, request path, HTTP status, timestamp, and
   response header names. Never bodies, cookies, tokens or the session id.
5. **Stop conditions.** Stop immediately on `rate-limited`,
   `account-restricted`, `checkpoint-required`, `untrusted-connection` or
   `failed`, and on any security email or device-approval prompt (then secure the
   account in the official app).
6. **Success criteria.** Count success only as `session-validated` followed by a
   second authenticated read. Then restart and confirm `loginBySession()`
   restores the saved session as `session-validated`.
7. **Disproof.** `session-expired`, `incompatible-response` or a checkpoint on
   the first read is evidence that a browser session is not accepted as-is.

## 9. Tests

| Concern                                                                                        | Test file                              |
| ---------------------------------------------------------------------------------------------- | -------------------------------------- |
| Session-id parsing, cookie application, rejection of malformed input                           | `tests/auth/session-id.test.ts`        |
| Validation semantics, every failure branch, no-persistence-before-validation, secret-free logs | `tests/auth/session-bootstrap.test.ts` |

Both run offline against scripted transport responses, through the dependency's
real request building, signing, cookie jar and error classes — not mocked
success values.
