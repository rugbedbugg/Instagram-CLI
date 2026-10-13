# Authentication and Session Integrity

> **Authentication compatibility is still unresolved.** This document describes
> how Instagram-CLI drives the authentication flows it already has, how it
> classifies their results, and how it protects saved sessions. Every behavior
> here is verified offline against scripted responses. No Instagram request,
> MQTT connection or login attempt was made, and nothing here shows that
> Instagram accepts these flows today.

Related: [Login workflow](login.md) (UI sequence),
[Compatibility profile](compatibility-profile.md) (client identity and session
precedence).

## 1. Scope

Instagram-CLI authenticates only through the flows that `instagram-private-api`
1.46.1 provides:

| Flow                  | Client method                             | Dependency call                                                                               |
| --------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| Saved session         | `InstagramClient.loginBySession()`        | `restoreCompatibilitySession()`, then the reels-tray cold-start request                       |
| Password              | `InstagramClient.login()`                 | `launcher.preLoginSync()`, `qe.syncLoginExperiments()` when no key is held, `account.login()` |
| Two-factor (TOTP/SMS) | `InstagramClient.twoFactorLogin()`        | `account.twoFactorLogin()`                                                                    |
| Checkpoint code       | `startChallenge()`, `sendChallengeCode()` | `challenge.auto(true)`, `challenge.sendSecurityCode()`                                        |

It does **not** implement CAA/Bloks login, device attestation or integrity
signals, alternative 2FA methods (WhatsApp, backup codes, login approval),
phone submission, captcha or any other challenge step. None of these is
emulated. When Instagram asks for one, the CLI reports it as a typed outcome
and stops.

## 2. Architecture

```text
login command / useInstagramClient
        │  presents outcomes; holds no protocol state
        ▼
AuthenticationCoordinator      source/auth/coordinator.ts
        │  one step at a time; transient verification context in memory
        ▼
InstagramClient auth methods   source/client.ts
        │  run the existing flows; classify results; validate session material
        ├── classifyAuthenticationError, describe*   source/auth/outcomes.ts
        ├── checkSessionMaterial                     source/auth/authorization.ts
        └── SessionPersistence                       source/auth/session-persistence.ts
                 │  owns the only request.end$ / error$ subscriptions
                 ▼
            SessionManager                           source/session.ts
                    atomic, per-account serialized writes
```

The client methods never throw for authentication results; they return an
`AuthenticationOutcome`. The coordinator is independent of Ink and is tested
without a UI.

## 3. Typed outcomes

`AuthenticationOutcome` (in `source/auth/outcomes.ts`) is a discriminated union
on `kind`:

| Kind                          | Meaning                                                                                                                                       | Next step         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `authenticated`               | A password, 2FA or challenge step established session material. `persisted` says whether it was saved                                         | done              |
| `session-validated`           | A restored session was accepted by an authenticated request                                                                                   | done              |
| `session-restored-unverified` | Restored locally; Instagram was unreachable, so not validated                                                                                 | done (unverified) |
| `no-session`                  | No saved file (`missing`) or one without authorization (`unusable`)                                                                           | enter credentials |
| `two-factor-required`         | Carries the in-memory `{identifier, method: 'totp' \| 'sms'}` context                                                                         | enter code        |
| `checkpoint-required`         | Instagram raised `challenge_required`                                                                                                         | request a code    |
| `checkpoint-code-sent`        | The challenge reached an email or phone code step                                                                                             | enter code        |
| `checkpoint-cleared`          | The challenge closed without establishing a session                                                                                           | enter credentials |
| `invalid-credentials`         | `bad-password` or `invalid-user`                                                                                                              | enter credentials |
| `verification-code-rejected`  | The challenge code was wrong (`IgChallengeWrongCodeError`)                                                                                    | re-enter code     |
| `rate-limited`                | HTTP 429, `spam`, or "Please wait a few minutes"                                                                                              | stop              |
| `session-expired`             | `login_required` or `user_has_logged_out`                                                                                                     | enter credentials |
| `network-error`               | The transport failed before a response                                                                                                        | stop              |
| `unsupported-challenge`       | A challenge step this CLI does not implement (`step` when known)                                                                              | stop              |
| `incompatible-response`       | A response that did not establish a session: `missing-session`, `missing-user`, `user-mismatch`, `malformed-response`, `malformed-two-factor` | enter credentials |
| `account-restricted`          | `sentry_block` or `inactive user`                                                                                                             | stop              |
| `failed`                      | `busy`, `invalid-state`, `no-checkpoint`, or `unexpected-error` (with HTTP status)                                                            | stop              |

`nextAuthenticationStep()` maps each outcome to what the user may do next. The
client never takes that step itself.

### Validation boundaries

- **HTTP 200 is not authentication.** A step succeeds only when
  `checkSessionMaterial()` finds session material in the client: the
  `ds_user_id` and `sessionid` cookies, or an `IGT:2` bearer token carrying both.
  For a password login, the response must also name the logged-in user, and that
  user must match the session's account. 2FA and challenge responses are checked
  against the user only when they include one.
- **Restored is not validated.** `loginBySession()` restores the file, then
  sends the request the post-login flow already started with (reels tray, cold
  start). Success gives `session-validated`. A transport failure gives
  `session-restored-unverified`, and the post-login requests are not repeated.
  A `login_required` response gives `session-expired`. Any other failure
  surfaces as its own outcome.
- **A network error is not expiry**, and **a rejected password does not touch
  the saved session**. No outcome deletes a session file. Only `logout` does.
- **Malformed responses.** An unparseable 2xx body (the dependency's
  `TransformError`, wrapped in `IgNetworkError`) and a 2xx without `status: ok`
  both give `incompatible-response` / `malformed-response`. Neither counts as
  success, and neither counts as a network failure.

## 4. Coordinator rules

- **One step at a time.** A call made while a step runs returns
  `failed/busy` and sends nothing. A repeated Enter therefore cannot submit a
  password or code twice.
- **No automatic retries or fallbacks.** Each user action makes at most one
  submission. The only chained request is the existing flow's: after
  `checkpoint-required`, the login UI asks Instagram for a code once. If that
  request raises another checkpoint, the UI stops.
- **Transient context.** The 2FA identifier and method, and whether a challenge
  is pending, live only in the coordinator's memory. They are never persisted or
  logged, and they are dropped when a step ends without needing them. A rejected
  code keeps the context, so the user can correct the code. Submitting a code
  with no pending verification returns `failed/invalid-state`.

## 5. Session persistence

### Activation and subscription lifecycle

`SessionPersistence` owns the client's only subscriptions to the dependency's
`request.end$` and `request.error$` streams.

| Event                                                 | Persistence                                             |
| ----------------------------------------------------- | ------------------------------------------------------- |
| `login()` / `loginBySession()` starts                 | deactivated, after flushing any due save                |
| password, 2FA or challenge step establishes material  | activated, then one immediate save                      |
| restored session validated                            | activated, then one immediate save                      |
| restored session unverified                           | activated; no immediate save                            |
| a response completes while active                     | one coalesced save, deferred past `error$`              |
| `login_required` / `user_has_logged_out` while active | suspended; the file is kept                             |
| `logout()` of this client's account                   | deactivated and pending writes awaited, before deletion |
| `shutdown()`                                          | due save flushed, then deactivated                      |

`activate()` is idempotent per manager. Repeated logins and logouts leave at
most one subscription to each stream, and logout returns to zero
(`tests/auth/session-overwrite.test.ts`, `tests/auth/lifecycle.test.ts`).

The dependency emits `end$` and then `error$` on consecutive ticks for the same
response. Response-driven saves run on `setImmediate`, after both, so a response
that ends the session is never written.

### Coalescing

At most one save per client is in progress. Saves requested meanwhile collapse
into one more save. Each save serializes the client state when it starts, so
the last save always reflects state at least as new as any earlier request. A
caller's `save()` resolves only after a write that began after the call.
`false` means the write failed, and nothing is retried.

### Atomic, serialized writes

`SessionManager.saveSession()`:

1. Drops `constants` and serializes to JSON **before touching the file system**.
   A state that cannot be serialized throws and leaves the previous file in
   place.
2. Writes a new `.session.ts.json.<pid>.<uuid>.tmp` beside the target, opened
   exclusively with mode `0600`, then `fsync`s and closes it.
3. Renames it over `session.ts.json`. The rename is atomic on POSIX file
   systems, and Node replaces the existing file on Windows. A file left `0644`
   by an older version becomes `0600`.
4. On any failure it removes the temporary file and rethrows. It never leaves a
   truncated session.
5. Syncs the directory on a best-effort basis.

Every save, load and delete for one account path runs through a process-wide
queue in call order, across `SessionManager` instances. A load therefore sees
every earlier save, and a delete cannot be undone by a save requested before
it. Other processes see either the old file or the new one.

The format is unchanged: the same `session.ts.json` path under
`advanced.usersDir`, the same JSON fields, and `~/.instagram-cli` and
`INSTAGRAM_CLI_HOME` behave as before. Account identifiers come only from the
saved file, under the precedence rules in
[compatibility-profile.md](compatibility-profile.md).

## 6. Error reporting and redaction

- User-facing text comes only from `describeAuthenticationOutcome()`, which
  takes no server text, passwords, codes, cookies, tokens or 2FA identifiers.
- Authentication failures are logged as the outcome kind plus
  `describeAuthenticationError()`: the error class and HTTP status, never the
  message, body or request options.
- Challenge steps are logged and shown only when they are plain identifiers
  (`[a-z_]{1,64}`).
- Session files contain cookies by design. They never contain passwords, codes
  or 2FA context (asserted in `tests/auth/lifecycle.test.ts`).

## 7. Known protocol limitations

- **Legacy password login may be refused.** Upstream evidence shows
  `accounts/login/` returning `needs_upgrade` for accounts that Instagram routes
  to CAA. That reply is an unclassified error (`failed/unexpected-error` with its
  HTTP status, or `incompatible-response`); it is not given a guessed meaning.
- **CAA/Bloks login is not implemented.** Instagram-CLI does not reproduce
  device-integrity or attestation signals.
- **2FA:** only TOTP (`verification_method` `0`) and SMS (`1`). A rejected 2FA
  code has no evidenced response shape, so it surfaces as
  `failed/unexpected-error` with its status.
- **Challenges:** only the dependency's `select_verify_method` and
  `delta_login_review` handling, plus code entry for `verify_email`,
  `verify_email_code`, `verify_phone`, `verify_phone_code`, `verify_sms` and
  `verify_sms_code` (the code steps instagrapi `a3b7538` handles in
  `challenge_resolve_simple`). Everything else is `unsupported-challenge`.
- **Rate limiting** is recognized from HTTP 429, the dependency's `spam` flag,
  and instagrapi's "Please wait a few minutes" message. The CLI only reports it
  and never waits or retries.
- **Logout is local.** It deletes the saved file and does not call Instagram.

## 8. Separately discovered defects (not changed here)

1. **TLS verification is disabled in the dependency.** `Request.send()` in
   `instagram-private-api` passes `strictSSL: false` ahead of `request.defaults`,
   so every REST request skips certificate verification. Fixing it means
   changing the HTTP transport, which was out of scope here. It should be
   repaired before any live validation.
2. **Debug logging captures API bodies.** The logger enables `ig:*` by default
   and writes dependency debug output to the log file. That output includes
   failed response bodies and the 2FA `two_factor_info`. AGENTS.md asks for that
   redirection to stay in place, so it is documented rather than changed.
3. **`IgNetworkError` copies the request options,** including the encrypted
   password form and the `Authorization` header. Logs record only error stacks,
   and the auth paths log only class and status, but any code that serializes
   such an error would expose them.
4. **`ConfigManager` writes `config.ts.yaml` non-atomically.**
5. **A hard crash mid-save** can leave an owner-only temporary file beside the
   session. It never replaces the session. `cleanupSessions()` deletes session
   files directly, outside the write queue.

## 9. Requirements for future live validation

Live validation needs explicit, separate authorization. Before it:

1. Resolve defect 1 (TLS verification) without disabling verification anywhere.
2. Use a dedicated test account. Never use a personal or shared account's
   credentials or saved session.
3. Keep `INSTAGRAM_CLI_HOME` pointed at a fresh directory, and keep a copy of
   any session file that must survive.
4. Make one manual attempt per scenario, with no loops, retries or scripted
   password submissions. Stop on `rate-limited`, `account-restricted` or
   `unsupported-challenge`.
5. Record only outcome kinds, request paths and HTTP statuses. Never record
   bodies, cookies or codes.
6. Count success only as `authenticated` or `session-validated` followed by an
   authenticated read. Then confirm that a restart restores the saved session
   as `session-validated`.
7. Treat `needs_upgrade` or an `incompatible-response` on the password flow as
   evidence that the legacy mechanism is refused. Do not treat it as something
   to work around.

## 10. Tests

| Concern                                                       | Test file                              |
| ------------------------------------------------------------- | -------------------------------------- |
| Original overwrite defect, restore safety, subscription count | `tests/auth/session-overwrite.test.ts` |
| Classification, messages, coordinator rules                   | `tests/auth/outcomes.test.ts`          |
| End-to-end scenarios through the real client                  | `tests/auth/lifecycle.test.ts`         |
| Atomic writes, interruption, concurrency                      | `tests/session.test.ts`                |

`tests/auth/_offline-instagram.ts` replaces only the socket layer beneath the
`request` library, so the dependency's signing, cookie jar, parsing, events and
error classes all run. Each request must match the next scripted step. The
harness's `forbidNetwork()` guard fails the worker on any real connection
attempt.
