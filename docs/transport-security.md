# Transport Trust and Credential Confidentiality

> Everything here is verified offline: against loopback TLS servers and proxies
> that use synthetic certificates, and against scripted Instagram responses. No
> Instagram request, MQTT connection or login attempt was made. Authentication
> compatibility is still unresolved; see [authentication.md](authentication.md).

Related: [Logging](logging.md), [Authentication and session integrity](authentication.md),
[Compatibility profile](compatibility-profile.md).

## 1. TLS verification for REST requests

### Original behavior

`Request.send()` in `instagram-private-api` 1.46.1
(`dist/core/request.js`) built every REST request's options with:

```js
defaultsDeep(userOptions, {/* … */ strictSSL: false /* … */}, this.defaults);
```

The `request` library turns `strictSSL: false` into `rejectUnauthorized: false`
(`request/request.js`), and its HTTPS proxy tunnel copies the same setting
(`request/lib/tunnel.js`). `defaultsDeep` lets the earlier source win, so
`ig.request.defaults` could not override it. Before the fix, a loopback probe
**accepted** a self-signed certificate, a certificate from an untrusted
authority and a certificate for the wrong host, both directly and through a
CONNECT proxy.

### Fix

The existing audited `patches/instagram-private-api+1.46.1.patch` deletes the
`strictSSL: false` entry. Nothing else in the transport changes. Node's
defaults then apply: certificate chains are verified against Node's trust
store, and the peer must match the server name.

### Options at the transport boundary

The tests record the options of every `tls.connect` call, whether made by
Node's HTTPS agent directly or by the proxy tunnel:

| Option               | Value                                     | Effect                                         |
| -------------------- | ----------------------------------------- | ---------------------------------------------- |
| `rejectUnauthorized` | unset (Node's default: `true`)            | untrusted or invalid chains fail the handshake |
| `servername`         | the `Host` header, or the tunnel's target | the certificate must name that host            |
| `ca`                 | unset (Node's trust store)                | no extra roots unless `NODE_EXTRA_CA_CERTS`    |

### Host header, SNI and the verified name

For a direct request, Node connects to the URL's host but takes the SNI server
name, and the name the certificate must match, from the `Host` header. Through
a CONNECT proxy, `tunnel-agent` uses the URL's host for the tunnel target, SNI
and verification, and sends `Host` only inside the tunnel.

A loopback probe showed what a mismatch would do. A request to
`https://localhost:<port>/` with `Host: wrong-host.invalid` sent SNI
`wrong-host.invalid` and **accepted** a peer holding only a trusted certificate
for `wrong-host.invalid`. A request intended for one host could therefore
authenticate a different peer that holds a valid certificate for whatever name
`Host` gives.

The dependency always sets `Host: i.instagram.com`, every REST URL uses
`https://i.instagram.com/`, and no repository or Instagram-CLI code overrides
either. The patch still enforces this: `Request.send()` refuses, before
connecting, any request in which a header named `host` in any case names
another host than the URL (case and port are ignored). Every spelling is
checked, because merged options can carry the dependency's `Host` beside a
caller's `host`, and Node would verify against the former. Redirects stay
consistent: `request` drops `Host` on a redirect, and Node derives it from the
new URL.

### Proxies

- **HTTP CONNECT proxy** (`state.proxyUrl = 'http://…'`): the TLS session runs
  end to end through the tunnel, with `servername` set to the target host. A
  proxy that answers with its own certificate is refused, unless the client
  trusts that certificate and it names the target host.
- **HTTPS proxy** (`https://…`): the connection to the proxy is verified
  against Node's trust store as well. `tunnel-agent` replaces a refused proxy
  certificate with a generic `ECONNRESET` error and keeps only the cause's text,
  so that case is reported as `network-error` rather than
  `untrusted-connection`. The connection is still refused and nothing is sent.

### Failures

A refused certificate surfaces as the authentication outcome
`untrusted-connection`, with reason `certificate`, `hostname` or `handshake`
(`classifyTlsFailure()` in `source/security/transport-trust.ts`). It is never
treated as being offline: a restore that hits it stops instead of continuing
unverified. Nothing was sent, and the saved session is kept.

### Fail-closed guard

`createInstagramApiClient()` calls `assertTransportTrust()` before any client
exists, and throws `InsecureTransportError` when:

- `NODE_TLS_REJECT_UNAUTHORIZED=0` is set. That disables verification for
  every TLS connection in the process, MQTT included. To trust an extra
  certificate authority, such as a corporate proxy's, use
  `NODE_EXTRA_CA_CERTS` instead.
- The installed `instagram-private-api/dist/core/request.js` still contains
  `strictSSL: false` or `rejectUnauthorized: false`, or lacks the Host binding
  check, meaning its patch was not applied.

Instagram-CLI never sets either bypass. MQTT (`mqtts`' `TlsTransport`) and the
CLI's own `fetch()` downloads use Node's default verification and receive no
TLS options.

## 2. Dependency patch reliability

- `npm ci` and `npm install` run `postinstall: patch-package --error-on-fail`.
  Without the flag, patch-package exits successfully on a developer machine
  even when a patch no longer applies, and fails only on CI. With it, any
  install whose patch does not apply fails (verified with a deliberately broken
  hunk: `npm ci` exits 1).
- `npm ci --ignore-scripts` skips the patch. The guard above then refuses to
  create a client, so the CLI fails closed with an actionable message instead
  of connecting without verification.
- The production build (`esbuild --production`) keeps dependencies external
  (`packages: 'external'`): `dist/` imports `instagram-private-api` from
  `node_modules` at runtime and contains no copy of its transport. The patched
  installed module is therefore what runs.
- `patches/` is included in the package's `files`, so an install from a packed
  tarball applies the same patch.

## 3. Credential confidentiality in diagnostics

See [logging.md](logging.md) for the full policy. In short:

- **Structured first.** Errors are logged as allowlisted fields: class, code,
  HTTP status, the redacted message, up to three causes and stack frames.
  Request options, responses, bodies and headers are never read. Other values
  are reduced by key before serialization: credential members become
  `[redacted]`, and request or response objects become `[omitted]`.
- **Central text redaction.** Every log entry passes `redactText()`. It removes
  bearer tokens, encrypted password envelopes, session cookies, credential
  headers, JSON and form members, query strings and challenge nonces. It is a
  last line of defense, not the only one.
- **Dependency debug output is allowlisted.** Each `debug` line is matched
  against reviewed message shapes per namespace. Response bodies, 2FA details,
  realtime payloads and FBNS or MQTT packets keep only their fixed wording, and
  anything unreviewed is logged as `message withheld (N chars)`. This applies to
  every namespace `DEBUG` enables, so verbose mode cannot disable it.
- **Credential-safe errors.** The patch makes `IgNetworkError` drop the
  request options (signed form, cookie jar and `Authorization` header) and the
  response.
- **Private files.** New log files are created `0600`, and a new logs directory
  `0700`. Existing files and directories are left as they are.

## 4. Tests

| Concern                                                                          | Test file                                    |
| -------------------------------------------------------------------------------- | -------------------------------------------- |
| Installed patch, TLS options, certificates, hostnames, proxies                   | `tests/transport/tls.test.ts`                |
| Host/URL binding (direct, proxied, duplicate spellings), production Host headers | `tests/transport/tls.test.ts`                |
| Fail-closed guard (`NODE_TLS_REJECT_UNAUTHORIZED`, unpatched)                    | `tests/transport/tls.test.ts`                |
| Secret-free logs through the production logger, verbose mode                     | `tests/security/log-confidentiality.test.ts` |
| Redaction, error descriptions and the debug allowlist                            | `tests/security/redaction.test.ts`           |
| TLS failure classification                                                       | `tests/auth/outcomes.test.ts`                |
| Atomic, ordered configuration writes                                             | `tests/persistence/config-atomic.test.ts`    |
| Challenge-code network failures                                                  | `tests/auth/challenge-errors.test.ts`        |

The TLS tests allow sockets only to the loopback servers they start, and fail
on any other connection. The certificates in `tests/transport/_fixtures/` are
synthetic and name only `localhost`, `127.0.0.1` or a reserved `.invalid` host.
`generate.sh` recreates them, and the test CA's private key is deleted after
signing.
