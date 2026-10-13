# Logging System Guide

## Overview

Instagram-CLI writes errors, warnings and diagnostics to log files rather than the console, because the terminal UI owns stdout and stdin.

Logs are **safe diagnostics**: they record what happened (endpoint path, method, HTTP status, error class and code, outcome kind, protocol stage) and never the credentials or private payloads involved. Redaction is unconditional. No debug flag, `DEBUG` pattern or verbose mode turns it off. The design is described in [transport-security.md](transport-security.md#3-credential-confidentiality-in-diagnostics).

Logs never contain:

- passwords or encrypted password submissions;
- verification codes, 2FA identifiers or challenge context and nonces;
- session cookies, bearer tokens or `Authorization` headers;
- request options, complete requests or responses, or server response bodies;
- realtime (MQTT/FBNS) message or packet payloads.

## Log location

Logs are stored in `~/.instagram-cli/logs/`, or `$INSTAGRAM_CLI_HOME/logs/` when that is set. Each session creates `session-YYYY-MM-DD_HH-MM-SS.log`.

New log files are created owner-only (`0600`), and a logs directory the logger creates is `0700`. Existing files and directories are not changed.

## Log file format

Each entry has an ISO timestamp, a level (`ERROR`, `WARN`, `INFO` or `DEBUG`), a context such as `[InstagramClient]`, and the message. An error entry is followed by its allowlisted description: class, code, HTTP status and redacted message, up to three causes, then stack frames.

```log
2026-10-13T14:30:45.123Z INFO [Logger]: Logger initialized
2026-10-13T14:30:45.345Z DEBUG [Dependency]: ig:request: Requesting POST /api/v1/accounts/login/
2026-10-13T14:30:45.401Z DEBUG [Dependency]: ig:request: Request POST /api/v1/accounts/login/ failed (response body withheld)
2026-10-13T14:30:45.402Z WARN [InstagramClient]: Login ended with invalid-credentials: IgLoginBadPasswordError (HTTP 400)
2026-10-13T14:30:46.010Z DEBUG [Dependency]: ig:mqtt:realtime:message: Received on /ig_message_sync (payload withheld)
2026-10-13T14:30:46.020Z DEBUG [Dependency]: mqtt:client:packet: message withheld (212 chars)
2026-10-13T14:30:47.456Z ERROR [InstagramClient]: Failed to fetch threads
RequestError: Error: socket hang up
Caused by: Error [ECONNRESET]: socket hang up
    at InstagramClient.getThreads (…)
```

## Dependency debug output

`instagram-private-api`, `instagram_mqtt` and `mqtts` log through the `debug` library. Instagram-CLI routes all of it into the log file, never stderr, from the moment the logger module loads:

1. `ig:*` is enabled by default. `DEBUG` replaces that pattern, for example `DEBUG=ig:request insta-cli chat`, and `DEBUG=` with an empty value keeps the default.
2. Each line is matched against reviewed message shapes for its namespace (`source/security/debug-diagnostics.ts`). Request lines keep the method and a sanitized path, with no origin, query or challenge nonce. Lines that embed bodies, 2FA details or payloads keep only their fixed wording.
3. Any line without a reviewed shape is logged as `<namespace>: message withheld (N chars)`. That includes every namespace a broader `DEBUG` pattern enables, so verbose runs still show that something happened without its contents.
4. The result also passes the central text redaction.

To diagnose a new dependency message, add a reviewed rule for its exact shape, with a test, rather than logging it raw.

## Using the logger in code

```typescript
import {createContextualLogger} from './utils/logger.js';

private readonly logger = createContextualLogger('InstagramClient');

try {
	await client.sendMessage(threadId, text);
} catch (error) {
	logger.error('Failed to send message', error);
}

logger.warn('MQTT connection lost, using fallback API');
logger.info('User switched account');
logger.debug('Processing message from thread 12345');
```

- Pass errors themselves to `logger.error()`. The logger reads only allowlisted fields: it never serializes `options`, `response`, `request`, bodies or headers.
- A non-error value passed to `logger.error()` is reduced by key first: credential members become `[redacted]`, and request or response members become `[omitted]`.
- Every message also passes `redactText()`, which removes tokens, cookies, credential members, query strings and challenge nonces. That is a last line of defense. Do not interpolate payloads, responses, headers, form data or realtime messages into log messages; log their kind, size or status instead.
- For authentication failures, log the outcome kind with `describeAuthenticationError()`, which gives class and HTTP status only.

## Logger initialization

`cli.ts` and `cli.mock.ts` call `initializeLogger()` at startup. Until then, entries are kept only in memory and dependency debug output is already filtered.

`await getLogger().flush()` resolves once every entry logged so far has been written. Writes are appended in order.

## Accessing logs

```bash
ls -lt ~/.instagram-cli/logs/ | head -1
tail -f ~/.instagram-cli/logs/session-*.log
grep "ERROR" ~/.instagram-cli/logs/session-*.log
```

Logs are designed to be safe to share for troubleshooting. Still review a log before sending it, since it contains usernames, thread IDs and request paths.

## Cleanup

```bash
find ~/.instagram-cli/logs -name "session-*.log" -mtime +7 -delete
insta-cli cleanup logs
```
