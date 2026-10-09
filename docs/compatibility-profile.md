# Instagram compatibility profile

Instagram-CLI owns the identity it asks its dependencies to present. The first-party
profile makes that identity reviewable and testable before attempting protocol
repairs. **This baseline is not claimed to work against live Instagram.** No app
version, device generation, authentication flow, or session format was modernized
in this milestone.

## Baseline and evidence

The extraction started from clean `main` at `8c64c21`, equal to `origin/main`, with
successful TypeScript CI run `37909848496`. Node >=22 remains required; Node 22 and
24 remain the supported validation matrix. Installed versions were
`instagram-private-api` **1.46.1**, `instagram_mqtt` **1.2.3**, Pastel **4.0.1**,
Chance **1.1.13**, and `mqtts` **1.5.0**. No resolved dependency versions changed.
Chance and its existing types are now explicit dependencies because our source
owns the device-generation sequence.

Before removing any constant patch, the installed libraries produced the fixtures
in [`tests/compatibility/_fixtures/`](../tests/compatibility/_fixtures/):

- `compatibility-baseline.json`: effective values, MQTT application metadata, hashes
  of ordered device/build samples and experiment strings, and a hash of 100
  synthetic username-generated identities.
- `rest-baseline.json`: shared identity headers and focused per-route method,
  path, form fields, body fields, and launcher configuration hashes, captured
  after the real URL-encoded form builder.

Fixtures contain only public compatibility constants and synthetic device inputs.
They contain no real accounts, sessions, encrypted passwords, or credentials.
Random/time-dependent fields are checked by shape and relationships, not snapshots.

| Surface                         | Preserved effective value                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| Android app version             | `416.0.0.47.66`                                                                                     |
| Version code                    | `382206157`                                                                                         |
| Bloks version                   | `388ece79ebc0e70e87873505ed1b0ff335ae2868a978cc951b6721c41d46a30a`                                  |
| REST and active realtime app ID | `567067343352427`                                                                                   |
| REST and realtime capabilities  | `3brTv10=`                                                                                          |
| Web UA Chrome component         | `131.0.6778.135`                                                                                    |
| Signing                         | HMAC-SHA256, signature version `4`; same public inherited signing and breadcrumb keys               |
| Default locale                  | `en_US`; `Accept-Language: en-US`                                                                   |
| Device samples                  | 40 ordered Android devices; SDK 23–27, Android 6.0–8.1.0                                            |
| Builds                          | 16 independently selected samples, including the duplicate `MRA58K`                                 |
| Supported capabilities          | SDK list `13.0`–`66.0`, face tracker `12`, segmentation, ETC2 compression, world tracker, gyroscope |
| Experiments                     | 814 general and 88 login entries, retaining their exact order and spelling                          |
| Active MQTT client info         | client capabilities `183`, endpoint capabilities `0`, publish format `1`, stack `3`                 |
| Active MQTT subscription topics | `88, 135, 149, 150, 133, 146`                                                                       |

The supported-capability SDK list is a separate capability declaration; it is not
the device's Android SDK level. The correspondence of app version, version code,
Bloks hash, signing material, and experiments to a coherent official release is
**unknown**. Passing these tests does not establish server acceptance.

## Dependency graph and ownership

Before extraction:

```text
instagram-private-api constants + patch-package version/Chrome edits
                    ↓
username → Chance(seed) → dependency device/build samples
                    ↓
               IgApiClient.state ← session deserialization
                    ↓                         ↓
             REST request builder    realtime connection builder
                                              ↑
                                  MQTT hard-coded client defaults
```

After extraction:

```text
InstagramCompatibilityProfile (source/compatibility/profile.ts)
          ↓                                      ↓
applyCompatibilityProfile                 realtimeCompatibilityOptions
          ↓                                      ↓
IgApiClientExt.state ──────────────────→ RealtimeClient
          ↓                                      ↓
real REST repositories/request builder    real connection builder → Thrift

username → generateCompatibilityDevice → owned ordered device/build data
                         ↓
                  same client state
                         ↑
                restored session fields
```

[`profile.ts`](../source/compatibility/profile.ts) defines typed application,
Android device, capability, signing, experiment, and realtime fields.
[`baseline-data.json`](../source/compatibility/baseline-data.json) owns the original
sample pools and long experiment lists. Their original MIT attribution is in
[`NOTICE.md`](../source/compatibility/NOTICE.md); repository/upstream attribution
and `LICENSE` remain unchanged.

[`client.ts`](../source/compatibility/client.ts) provides four explicit boundaries:

1. `createInstagramApiClient()` constructs `IgApiClientExt`, applies the profile,
   and initializes the default locale. Keeping the extended class matters:
   `withRealtime()` otherwise replaces an ordinary client with a new instance.
2. `applyCompatibilityProfile()` clones `state.constants`, replaces the owned
   constants, and sets capabilities and supported capabilities. It preserves
   device identifiers and locale. All these state fields are writable in the
   installed library. A non-enumerable per-instance web-UA accessor replaces the
   Chrome patch; no production prototype is modified and no session field is added.
3. `generateCompatibilityDevice()` uses the original Chance sequence and our own
   sample data. Both credential and saved-session entry points call it.
4. `realtimeCompatibilityOptions()` supplies the public `connectOverrides` for
   application ID and MQTT capability/format/stack fields. `InstagramClient` passes
   them at its existing realtime integration point. App version, app UA, language,
   and `X-IG-Capabilities` continue to read the same state as REST.

The dependency remains responsible for request behavior: endpoints, retries,
encoding/encryption, launcher configuration queries, topic/query IDs, and response
handling. Hosts, OTA query fields, and the unused Orca application ID
`124024574287414` remain dependency constants. Orca is used by its optional
`simulate.facebookOta()` flow; Instagram-CLI uses its own smaller startup flow.
These are mapped boundaries, not undocumented application-profile overrides.

## REST identity and startup

The real request builder derives `User-Agent` from app version, `deviceString`,
language, and version code. `X-IG-App-ID`, `X-Bloks-Version-Id`, and
`X-IG-Capabilities` read the configured state. Device headers use UUID and the
`android-…` device ID; timeline additionally sends advertising ID and UUID through
`X-Google-AD-ID` and `X-DEVICE-ID`.

Locale is persisted state: `X-IG-App-Locale` and `X-IG-Device-Locale` carry
`state.language`, while `Accept-Language` replaces its underscore with a hyphen.
Layout RTL defaults to `false`, connection type to `WIFI`, radio type to
`wifi-none`, ads opt-out to false, and HTTP engine to `Liger`. Timezone offset
comes from the local machine and is persisted. Pigeon/raw-client timestamps,
connection-speed simulation, battery level, and charging state retain dependency
behavior; they are not application-version constants. EU-DC, MID cookie, WWW
claim, authorization, CSRF and user cookies remain session/server state.

The signed form contains `ig_sig_key_version` and
`signed_body=<HMAC hex>.<JSON>`. Login retains the real RSA/AES password envelope
`#PWD_INSTAGRAM:4:<timestamp>:<base64>` and fields `username`, `enc_password`,
`guid`, `phone_id`, `_csrftoken`, `device_id`, `adid`, `google_tokens`,
`login_attempt_count`, `country_codes`, and `jazoest`. `jazoest` sums the phone-ID
character codes with a `2` prefix. The country-code list stays hard-coded to
`[{"country_code":"1","source":"default"}]` in the repository method; it has no
state override. No login waterfall ID is sent by this implementation.

If a password-encryption key is absent, login first calls QE sync to obtain it.
Encryption key/key ID can be restored from a session and subsequently replaced
by response headers. Guest QE uses UUID as `id`; authenticated QE uses the saved
user ID plus UUID and CSRF. Launcher sync uses UUID before login and user/UUID
fields after login. The launcher configuration lists remain request behavior and
are pinned by fixture hashes.

Instagram-CLI's pre-login flow is launcher sync. Its post-login cold-start flow
requests reels then timeline. Reels passes supported capabilities as a nested
URL-encoded form; timeline is also unsigned and sends UUID as its form
`device_id`, phone ID, timezone, and an ephemeral client-session ID. The harness
covers these paths plus authenticated launcher sync and both QE entry points.
It does not invoke the dependency's full `simulate` flow.

The web-UA getter is observable but no active request path in this checkout uses
it. Its inherited whitespace is preserved: `devicePayload.model` includes a
leading space because the dependency splits on `;` without trimming.
Other optional operations use a UUID as password-change `waterfall_id`, or a
fresh GUID for account lookup/upload contexts. They are operation identifiers,
not a second device pool, and are not changed here.

## MQTT identity

Active realtime uses `cookie_auth`, the app UA in both `clientInfo.userAgent` and
`appSpecificInfo['User-Agent']`, app version, capabilities, and normalized locale
from the REST state. It uses **phone ID** as MQTT `deviceId` and its first 20
characters as `clientIdentifier`. The account ID comes from `cookieUserId`.
`clientMqttSessionId` is the low 32 bits of the current millisecond clock, generated
for each construction rather than persisted.

The captured payload also retains network type `1`, subtype `0`, foreground
flags, empty device secret, platform `android`, route `django`, message-type
blacklist `direct, typing_type`, and auth-cache flag `0`. Everclear subscription
query IDs and numeric topic IDs stay in the library's protocol builders. The
public overrides do not expose `appSpecificInfo` or those query IDs; moving them
would require changing that library's behavior and is deferred.

GraphQL subscription builders retain their query IDs and create transient
subscription GUIDs. Zero-provision binds phone ID; typing/ads and Skywalker bind
user ID. Iris sends `snapshot_app_version` from the same state. Tests exercise
these builders and Iris compression without publishing anything.

**Unused FBNS is a separate boundary.** Instagram-CLI never calls `withFbns()` or
its connection method. The library hard-codes FBNS app ID `567310203415052`,
client capabilities `183`, endpoint capabilities `128`, `device_auth`, and topics
`76,80,231`; its public connection options do not offer identity overrides.
Its UA takes app version/code, locale, model and resolution from state, but
hard-codes density `4.0`, ABI `x86:armeabi-v7a`, and package
`com.instagram.android`. The inherited FBDM text also lacks a closing brace.
These values are characterized offline and intentionally not unified with the
active realtime app ID. FBNS would require a separate compatibility decision if
enabled later.

## Device and session boundaries

```text
username (case-sensitive)
    ↓
Chance 1.1.13 seed
    ↓
pick one of 40 devices
    ↓
16 hexadecimal characters → android-… device ID
    ↓
GUID → UUID; GUID → phone ID; GUID → advertising ID
    ↓
pick one of 16 builds (independent of the device)
    ↓
state serialization → SessionManager → session.ts.json
```

Sample order, duplicate builds, and random-number call order are compatibility
contracts. Tests compare the owned generator to the library and to the
pre-extraction 100-seed digest. The device's SDK, release, DPI, resolution,
manufacturer/model, device codename and CPU string remain observable.

| Field group                                                                         | Creation and restoration                                         | Future boundary                                                                        |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `deviceId`, UUID, phone ID, ad ID                                                   | Deterministic from username, persisted, restored over generation | Keep stable per account; do not regenerate for an app update                           |
| `deviceString`, build                                                               | Seeded selection, persisted, restored                            | Explicit device migration, never cosmetic replacement                                  |
| Locale, timezone, capability header, supported capabilities, radio/connection state | Defaults initially, then persisted/restored                      | Locale is account state; capabilities need an explicit app-profile precedence decision |
| App version/code, Bloks, signing, experiment strings, REST app ID                   | Owned constants; normal saves remove `constants`                 | Application-profile controlled for ordinary saved sessions                             |
| Cookies, authorization, claims, encryption key/key ID                               | Server/session state, persisted                                  | Authentication material, never part of reports/fixtures                                |
| Pigeon/client session GUIDs                                                         | Device ID plus rounded 20-minute time bucket and a distinct seed | Generated getters; not serialized; lifetimes are serialized                            |
| MQTT session ID and subscription GUIDs                                              | Clock or fresh generation during construction                    | Transient; normalize or check format/relationship                                      |

The existing order is deliberately unchanged: **apply profile → generate device →
deserialize session**. `SessionManager.saveSession()` strips constants. Thus a
normal session follows new application constants but can retain old capabilities,
supported capabilities, device, build, locale, and timezone. REST and MQTT share
those retained fields, even when they differ from the selected profile.

A legacy/raw imported state containing `constants` can override the entire
application constants object. REST can then use an old app ID while MQTT uses the
selected profile's ID (previously a hard-coded default). A test preserves this
exception rather than pretending all sessions are coherent. Explicitly calling
`applyCompatibilityProfile()` after deserialization restores app constants and
capabilities without changing IDs, device/build, or locale. **Production does not
perform that reapplication in M1.**

Authorization has another inherited edge: MQTT reads `parsedAuthorization` before
asking for `cookieUserId`, while that getter parses authorization only if the
user-ID cookie is absent. A cookie can therefore win over an unparsed header;
an authorization-only state needs parsing before connection construction; and a
cached parsed session can lag a changed authorization header for one construction.
REST reads the authorization header directly. Tests expose all three cases.
The MQTT builder also converts user ID through `Number` before `BigInt`, so IDs
outside JavaScript's exact integer range are a known precision boundary.

No session migration or storage change occurs here. Existing `~/.instagram-cli`
and `INSTAGRAM_CLI_HOME` remain valid and real local state was not used by this
milestone. Whether a server requires re-login for a particular identity change
cannot be determined offline. Treat device/model/build/ID or authentication-flow
changes as explicit reauthentication candidates; never silently rewrite them.

## Offline harness and sanitized report

[`tests/compatibility/`](../tests/compatibility/) has a local TypeScript project so
its dependency seams are type-checked instead of suppressing unresolved types.
Run it with the selected runtime:

```bash
mise exec node@22 -- npx --no-install tsc -p tests/compatibility/tsconfig.json --noEmit
mise exec node@22 -- npx --no-install ava 'tests/compatibility/*.test.ts'
```

REST replaces `request`'s supported HTTP-module transport through request defaults,
disables proxy/agent use, captures the fully encoded headers/form, then throws a
unique sentinel **before creating a socket**. Repository logic, signing, password
encryption, header construction, cookies and URL encoding remain real. Tests
verify the expected sentinel and exactly one capture; other errors fail the test.

MQTT accesses the installed runtime's private connection builder through a typed,
test-only bridge. It does not call the real `connect()` method. It serializes and
decodes actual Thrift and checks actual compression. A separate application
integration test intercepts `connect()` to check the options passed by
`InstagramClient`; it also replaces the inbox request used for Iris state.
Private seams are confined to tests and will fail visibly if a dependency changes.

Harness workers deny HTTP, HTTPS, TLS, sockets and fetch as a second barrier and
assert zero fallback attempts. They use fixed dummy accounts and AVA's temporary
state setup. There are **zero Instagram HTTP requests, zero Instagram MQTT
connections, and zero live login attempts**. Constructing a dummy login request
in memory is not a service login attempt.

[`compatibilityReport()`](../source/compatibility/report.ts) is an internal,
allowlisted diagnostic: app fields, non-unique device characteristics, locale,
REST/MQTT app IDs and selected-profile match flags. It reads no files and sends
nothing. It excludes credentials, authorization, cookies, UUID/device/ad/phone
IDs, session IDs, claims, encryption keys, and usernames. Pass an already
constructed client with a generated device, preferably a synthetic one. No public
CLI command was added. Never print complete serialized state or MQTT payloads.

## Patch audit

| Patch hunk                                                          | Classification                               | Disposition and reason                                                                  |
| ------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `instagram-private-api` app version/code in compiled constants      | Compatibility constant                       | Removed; configured through instance `state.constants`                                  |
| `instagram-private-api` Chrome version in compiled web-UA getter    | Compatibility constant                       | Removed; non-enumerable instance accessor reads the owned Chrome input                  |
| `instagram-private-api` reply argument and imported type in `.d.ts` | Project integration behavior                 | Retained; describes the reply API used by this project's chat code                      |
| `instagram-private-api` reply fields in `broadcastText()`           | Compatibility behavior / project integration | Retained; changes request payload composition, which state configuration cannot express |
| Pastel option-validation render: `exitOnCtrlC: false`               | Project integration behavior                 | Retained; internal render call has no per-client profile setting                        |
| Pastel argument-validation render: `exitOnCtrlC: false`             | Project integration behavior                 | Retained for the same Ctrl+C ownership contract                                         |
| Pastel normal command render: `exitOnCtrlC: false`                  | Project integration behavior                 | Retained so this application controls full-screen teardown                              |

There is no `instagram_mqtt` patch and no unrelated or separately classified bug-fix
hunk in the current patch set. Removing the remaining patches would change
behavior. This milestone removes only replaceable compatibility constants.

## Known inconsistencies and M2 recommendation

The baseline deliberately combines patched app version 416/code 382206157 with
Bloks, signing, experiments and supported capabilities inherited from a dependency
whose original default was app 222/code 350696709. Their true generation/coherence
is unverified. It also combines old Android device samples with independently
chosen builds and Chrome 131. The synthetic baseline selects Android 7.1.1,
Xiaomi MI MAX 2, and `JZO54K`; no matching device/build relationship is enforced.
Login's country code remains `1` regardless of locale/timezone. Session precedence,
authorization-cache discrepancies, and dormant FBNS differences are described above.
None were repaired during extraction.

For M2, use **one fixed, coherent modern Android device profile for newly created
account state**, rather than immediately introducing another device pool. Obtain
all app/version-code/Bloks/capability/experiment and device/build/SDK/UA evidence
from the same selected official Android application build and matching device
configuration, using authorized offline inspection and recording provenance.
Do not assemble a fingerprint from unrelated snippets or pick a version merely
because it is newest. A pool would multiply combinations before one combination
is understood.

Keep per-account generated identifiers stable. Existing accounts should retain
their saved device identity until an explicit, reversible migration is designed:
record the selected profile, preserve a backup, decide when reauthentication is
required, and migrate device/build fields together. Application constants and
capabilities should eventually have documented precedence after deserialization;
legacy raw constants must be handled explicitly rather than silently mixed with
MQTT defaults. None of this migration is implemented here.

For each future profile change, review the data diff, explain each changed value
and its source, update focused expectations deliberately, exercise changed-profile
REST/MQTT tests and old-session cases, and run complete isolated Node 22/24 gates.
Keep a separate, explicitly authorized milestone for live validation and login
repair. An offline coherent fingerprint still does not prove Instagram accepts it.
