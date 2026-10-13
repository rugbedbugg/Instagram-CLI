# Instagram compatibility profile

Instagram-CLI owns the identity it asks its dependencies to present. M1 extracted
the inherited identity into first-party source. M2 replaced it with **one
evidence-backed, internally coherent modern Android profile** and made that
profile authoritative after session restore.

> **A coherent profile does not by itself prove that Instagram currently accepts
> login.** Every M2 result is offline. No Instagram HTTP request, MQTT connection,
> or login attempt was made. Server acceptance remains unverified.

| Question                             | Answer                                                               |
| ------------------------------------ | -------------------------------------------------------------------- |
| Selected profile                     | `android-448.0.0.0.20-pixel-8-pro`                                   |
| What a new account presents          | Instagram 448.0.0.0.20 (1065560286), Pixel 8 Pro on Android 14       |
| What an existing saved account keeps | Its device, build and identifiers; only application fields change    |
| Who decides application fields       | `currentCompatibilityProfile`, applied after every session restore   |
| Is the M1 identity still available   | Yes, as `legacyInheritedProfile`, a test and documentation reference |
| Recommended next step (M3)           | Implement CAA/Bloks login before any live test (see section 11)      |

Source: [`profile.ts`](../source/compatibility/profile.ts),
[`legacy-profile.ts`](../source/compatibility/legacy-profile.ts),
[`client.ts`](../source/compatibility/client.ts),
[`report.ts`](../source/compatibility/report.ts).

## 1. M1 inherited profile (legacy reference)

M1 preserved the effective identity of patched `instagram-private-api` 1.46.1.
It now lives in `legacyInheritedProfile` and is never used to construct a new
account. The M1 fixtures in
[`tests/compatibility/_fixtures/`](../tests/compatibility/_fixtures/) are
unchanged; tests prove the legacy reference still reproduces them byte for byte,
including the 40-device pool and the 100-seed identity digest.

| Field                  | M1 inherited value                                                 |
| ---------------------- | ------------------------------------------------------------------ |
| App version            | `416.0.0.47.66`                                                    |
| Version code           | `382206157`                                                        |
| Bloks version          | `388ece79ebc0e70e87873505ed1b0ff335ae2868a978cc951b6721c41d46a30a` |
| App ID                 | `567067343352427`                                                  |
| Capabilities           | `3brTv10=`                                                         |
| Devices                | 40 username-seeded samples, Android 6.0–8.1 (SDK 23–27)            |
| Builds                 | 16 samples chosen independently of the device                      |
| Supported capabilities | SDK list `13.0`–`66.0`, face tracker `12`, six entries             |
| MQTT client info       | capabilities `183`, endpoint `0`, publish format `1`, stack `3`    |

Its version/code came from a patch, while Bloks, signing, experiments and the
supported capabilities came from a dependency whose own default was app 222.
They were never evidenced as one build, and indexed 4xx builds require Android 9+
while the pool is SDK 23–27. The M1 identity was therefore not coherent.

## 2. M2 research sources

Retrieved 2026-10-13. Public repositories, APK metadata pages and vendor
documentation only; no Instagram endpoint was contacted.

| Source                                                                                                                                                                                                 | Version / commit                        | What it supports                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [instagrapi `config.py`](https://github.com/subzeroid/instagrapi/blob/a3b7538b1a230861cd4f43e75694fbf00950aea8/instagrapi/config.py)                                                                   | 3.0.24, `a3b7538` (2026-10-13)          | App profiles 449/448/446/428/385/364 with paired version code and Bloks hash; Pixel 8 Pro device settings; supported capabilities; unused `LOGIN_EXPERIMENTS`                                                          |
| [instagrapi `mixins/private.py`](https://github.com/subzeroid/instagrapi/blob/a3b7538b1a230861cd4f43e75694fbf00950aea8/instagrapi/mixins/private.py)                                                   | `a3b7538`                               | REST headers: `X-IG-Capabilities: 3brTv10=`, app ID, `X-FB-HTTP-Engine: Tigon/MNS/TCP`, current header set                                                                                                             |
| [instagrapi `utils/auth.py`](https://github.com/subzeroid/instagrapi/blob/a3b7538b1a230861cd4f43e75694fbf00950aea8/instagrapi/utils/auth.py)                                                           | `a3b7538`                               | Signed bodies are sent as `signed_body=SIGNATURE.<json>` with no HMAC or key version                                                                                                                                   |
| [instagrapi `realtime/client.py`](https://github.com/subzeroid/instagrapi/blob/a3b7538b1a230861cd4f43e75694fbf00950aea8/instagrapi/realtime/client.py)                                                 | `a3b7538`                               | MQTT app ID `567067343352427`, client capabilities `183`, endpoint `0`, publish format `1`, stack `3`, same topics and `app_specific_info`                                                                             |
| [instagrapi `mixins/auth.py`](https://github.com/subzeroid/instagrapi/blob/a3b7538b1a230861cd4f43e75694fbf00950aea8/instagrapi/mixins/auth.py)                                                         | `a3b7538`                               | `login()` is CAA/Bloks first and calls legacy only on a server `CAA_LOGIN_FALLBACK`; `login_legacy()` tries CAA on `needs_upgrade`; saved app profiles are kept unless explicitly overridden                           |
| [instagrapi CHANGELOG](https://github.com/subzeroid/instagrapi/blob/a3b7538b1a230861cd4f43e75694fbf00950aea8/CHANGELOG.md)                                                                             | 3.0.0–3.0.24                            | 3.0.0 (2026-09-13) made CAA the default login; 3.0.3 follows the CAA fallback instruction; 3.0.7 made 448 default; 3.0.20 made 449 default                                                                             |
| [instagrapi PR #2812](https://github.com/subzeroid/instagrapi/pull/2812)                                                                                                                               | `1ba80a1`, merged 2026-09-19            | 448.0.0.0.20 / 1065560286 / `0bc46a03…` "captured and verified live on this profile (login, reads and publishes)" by the maintainer                                                                                    |
| [instagrapi PR #2855](https://github.com/subzeroid/instagrapi/pull/2855)                                                                                                                               | `52346dd`, merged 2026-10-04            | 449.0.0.52.84 / 1079242191 / `799db3e3…` from "the User-Agent build and API Bloks version checked against the current Android app"; "**Current native 449 login has not been observed.**"                              |
| [instagrapi PR #2853](https://github.com/subzeroid/instagrapi/pull/2853) and maintainer comment                                                                                                        | closed 2026-10-06                       | The 449 manifest `versionCode` 385511871 and bundled Bloks asset `a5285a65…` differ from the runtime UA build and API Bloks version; the maintainer rejected the manifest/bundled values                               |
| [instagrapi PR #2792](https://github.com/subzeroid/instagrapi/pull/2792), [#2480](https://github.com/subzeroid/instagrapi/pull/2480), [#2864](https://github.com/subzeroid/instagrapi/pull/2864)       | `6f2bd23`, `cec4c02`, docs              | `needs_upgrade` handled through CAA; physical Pixel 8 Pro hardware profile; the UA must change together with an app selection                                                                                          |
| Issues [#2773](https://github.com/subzeroid/instagrapi/issues/2773), [#2791](https://github.com/subzeroid/instagrapi/issues/2791), [#2807](https://github.com/subzeroid/instagrapi/issues/2807) (open) | 2026-08-20 to 2026-09-29                | Legacy `accounts/login/` returns `error_type: needs_upgrade` for some accounts/IPs; a maintainer ten-account check on the 448 default (2026-09-20): nine fresh logins, one HTTP 429; account-specific failures persist |
| [aiograpi `config.py`](https://github.com/subzeroid/aiograpi/blob/bf0e9090c2f16bb8137ee92f42875b1ebc277646/aiograpi/config.py)                                                                         | 2.0.20, `bf0e909`                       | Identical profile catalog. Same maintainer, so **not independent** corroboration                                                                                                                                       |
| [HushGram README](https://github.com/sherifrahim/HushGram/blob/166f17a3e06e318fd170532308f0a8098716cf10/README.md)                                                                                     | `166f17a`                               | Secondary: 449.0.0.52.84 arm64 build 385511871; current stable 450.0.0.50.77, arm64 builds 385611395–385611438; Android 9+                                                                                             |
| [APKMirror Instagram listings](https://www.apkmirror.com/apk/instagram/instagram-instagram/)                                                                                                           | search-index snippets                   | Secondary: 293–450 builds listed as Android 9.0+; release pages refused automated retrieval (HTTP 403), so no listing was read directly                                                                                |
| [Google factory images, husky](https://developers.google.com/android/images#husky)                                                                                                                     | page retrieved 2026-10-13               | Official: Pixel 8 Pro codename `husky`; Android 14 builds `UD1A.230803.022` to `AP2A.240905.003` (Sep 2024, final global Android 14); Android 15 starts at `AP3A.241005.015`                                           |
| [Google Pixel tech specs](https://support.google.com/pixelphone/answer/7158570)                                                                                                                        | page retrieved 2026-10-13               | Official: Pixel 8 Pro 1344 × 2992 at 489 PPI, Google Tensor G3                                                                                                                                                         |
| npm registry: `instagram-private-api`, `instagram_mqtt`                                                                                                                                                | 1.46.1 (2024-03-07), 1.2.3 (2024-04-23) | The installed Node dependencies are unmaintained since 2024 and are not current protocol evidence                                                                                                                      |

An official APK was not downloaded or decompiled. Its manifest values are known
from secondary indexes, and PR #2853 shows they are not the values the running
app sends; reconstructing the runtime values needs observation of a running app,
which is outside this offline milestone.

## 3. Candidate profiles

| Criterion                | Inherited 416                         | **A: instagrapi 448 (selected)**                  | B: instagrapi 449 (maintained default) | C: official 450.0.0.50.77 APK                |
| ------------------------ | ------------------------------------- | ------------------------------------------------- | -------------------------------------- | -------------------------------------------- |
| Version / code / Bloks   | 416.0.0.47.66 / 382206157 / `388ece…` | 448.0.0.0.20 / 1065560286 / `0bc46a…`             | 449.0.0.52.84 / 1079242191 / `799db3…` | 450.0.0.50.77 / manifest 3856114xx / unknown |
| Internal consistency     | Mixed sources; no                     | Captured together from one running app            | Captured together from one running app | Runtime build and Bloks unknown              |
| Source quality           | Patched dependency                    | Maintainer capture, PR #2812                      | Maintainer check, PR #2855             | Secondary indexes for manifest codes only    |
| Known login              | Fails upstream (`needs_upgrade`)      | Maintainer-reported live login; 9/10 fresh logins | Not observed (stated in PR)            | None                                         |
| Bloks pairing            | Unverified                            | Paired                                            | Paired                                 | Missing                                      |
| Device plausibility      | Android 6–8; below Android 9 minimum  | Pixel 8 Pro, Android 14                           | Same device                            | Would need a device choice                   |
| REST/MQTT applicability  | Yes                                   | Yes (constants only)                              | Yes (constants only)                   | Not constructible                            |
| Session migration safety | Baseline                              | App-level change only                             | App-level change only                  | Unknown fields                               |
| Newest                   | No                                    | No                                                | Newer                                  | Newest stable                                |

**C was rejected** because the version code and Bloks hash the app sends cannot be
reconstructed offline; the APK manifest values are known to differ from them.
Inventing them would violate the selection rule. **B was a close second**: it is
the maintained default and equally coherent, but its PR explicitly states that no
native 449 login has been observed. **A was selected** because its three release
fields and device were captured together and it is the only modern profile with
maintainer-reported live login. It is one release older than B; newer is not a
selection criterion. Switching to B later is a one-object, reviewed profile update.

## 4. Selected profile

| Field            | Value                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Profile ID       | `android-448.0.0.0.20-pixel-8-pro`                                                                                       |
| App version      | `448.0.0.0.20`                                                                                                           |
| Version code     | `1065560286` (runtime UA build number, not the manifest `versionCode`)                                                   |
| Bloks version    | `0bc46a03e177bfc9bc8d611918815acf248fa9c77754d807d6a5951dc9ce9432`                                                       |
| Minimum Android  | SDK 28 (Android 9)                                                                                                       |
| App ID           | `567067343352427` (REST and active MQTT)                                                                                 |
| Capabilities     | `3brTv10=`                                                                                                               |
| Android / SDK    | 14 / 34                                                                                                                  |
| Manufacturer     | `Google/google`                                                                                                          |
| Model / device   | `Pixel 8 Pro` / `husky`                                                                                                  |
| CPU field        | `husky`                                                                                                                  |
| Resolution / DPI | `1344x2992` / `480dpi`                                                                                                   |
| ABI              | Not represented in the REST UA or MQTT payload; unknown and not sent                                                     |
| OS build         | `AP2A.240905.003` (used only by the inactive web UA)                                                                     |
| App UA           | `Instagram 448.0.0.0.20 Android (34/14; 480dpi; 1344x2992; Google/google; Pixel 8 Pro; husky; husky; en_US; 1065560286)` |
| Supported caps   | SDK list `119.0`–`142.0`, face tracker `14`, `ETC2_COMPRESSION`, gyroscope                                               |
| MQTT client info | capabilities `183`, endpoint `0`, publish format `1`, stack `3`, `cookie_auth`                                           |

The UA is byte-identical to the one instagrapi PR #2812 published for this
profile. `ApplicationRelease` holds version, code and Bloks hash as one frozen
object; `defineCompatibilityProfile()` rejects any profile whose triple is not a
declared release, or whose device is below the release's minimum SDK.

## 5. Evidence strength per field

| Field                           | Classification                                          | Notes                                                                                                                      |
| ------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| App version                     | Maintained-client evidence                              | Not found on APK indexes; the `X.0.0.0.N` pattern suggests a pre-release channel build (inference)                         |
| Version code                    | Maintained-client evidence                              | Runtime UA build; official manifest code unknown                                                                           |
| Bloks version                   | Maintained-client evidence                              | Captured with the version above                                                                                            |
| Minimum Android SDK 28          | Strong inference                                        | Every indexed 293–450 build lists Android 9.0+; not verified from an APK                                                   |
| Android 14 / SDK 34             | Official mapping, maintained-client pairing             | API 34 is Android 14; Pixel 8 Pro shipped Android 14                                                                       |
| Model `Pixel 8 Pro`, `husky`    | Official                                                | Google factory images                                                                                                      |
| Resolution `1344x2992`          | Official                                                | Google tech specs                                                                                                          |
| DPI `480dpi`                    | Strong inference, maintained-client evidence            | 489 PPI falls in the xxhdpi (480) bucket                                                                                   |
| Manufacturer `Google/google`    | Maintained-client evidence, strong inference            | Instagram writes `MANUFACTURER/brand` when they differ in case                                                             |
| CPU field `husky`               | Maintained-client evidence                              | Tensor devices report the codename as hardware (inference)                                                                 |
| OS build `AP2A.240905.003`      | Official                                                | Final global Android 14 build for husky; only used by the inactive web UA                                                  |
| App ID                          | Inherited stable constant                               | Same in instagrapi REST and MQTT                                                                                           |
| `X-IG-Capabilities`             | Inherited stable constant                               | instagrapi still sends `3brTv10=`; not tied to 448 specifically                                                            |
| Supported capabilities          | Maintained-client evidence                              | instagrapi's list (last edited 2022), in use during the reported 448 logins; not generation-verified                       |
| MQTT client/endpoint caps       | Maintained-client evidence, inherited stable constant   | Identical in instagrapi realtime                                                                                           |
| Signature version/key           | Inherited but unverified; likely obsolete               | instagrapi sends `SIGNATURE.` without HMAC or key version. Not changed: the dependency's request builder computes the HMAC |
| Experiments / login experiments | Inherited but unverified; obsolete in maintained client | instagrapi no longer sends experiments in QE sync. Only our guest QE (missing encryption key) sends them                   |
| Web UA Chrome `131.0.6778.135`  | Inherited, not relevant                                 | No active request path uses the web UA                                                                                     |
| FBNS density/ABI/app ID         | Not relevant                                            | FBNS is never started                                                                                                      |
| Default locale `en_US`          | Not relevant (account state)                            | Persisted per account                                                                                                      |

## 6. Device policy

```text
new account (no saved session for the username)
    ↓
one canonical device template: Pixel 8 Pro, Android 14, AP2A.240905.003
    ↓
Chance(username): android-<16 hex> device ID → UUID → phone ID → advertising ID
    ↓
persisted in session.ts.json; stable from then on
```

There is no device pool and no per-invocation randomness. Identifiers stay
deterministic per case-sensitive username and are independent of the app
profile, so a later app update cannot change them. Removing the M1 pool selection
changes the random stream: a username with **no** saved state now derives
different identifiers than M1 would have. Saved accounts are unaffected (below).

## 7. Session precedence

```text
generateCompatibilityDevice(username)      fallback for incomplete state
        ↓
restoreCompatibilitySession(session)
    drop persisted `constants` (never trusted)
    deserialize: cookies, authorization, device, build, IDs, locale, timezone
        ↓
applyCompatibilityProfile(profile)         authoritative application fields
    version, code, Bloks, app ID, signing, experiments,
    capabilities header, supported capabilities, web UA accessor
        ↓
REST request builder        MQTT connection builder (+ profile app ID/caps overrides)
```

`InstagramClient.loginBySession()` uses this flow and logs, without values, which
saved application fields were replaced. Production has no remaining direct
`state.deserialize()` call; a test enforces that. Dropping persisted constants
also matters beyond the profile fields: a stale raw `HOST` hides the session
cookie from the MQTT builder.

Credential login (`InstagramClient.login()`) for a username with a saved session
calls `restoreAccountIdentity()`: it restores device, build, device ID, UUID,
phone ID and advertising ID, all or nothing, and no authentication state.
Applying a profile never touches those fields. Tests prove that stale persisted
constants, capabilities and supported capabilities lose to the profile, that REST
and MQTT then agree, that repeated application leaves identifiers unchanged, and
that the raw dependency deserializer is still unsafe.

| Field group                                                      | Owner                    |
| ---------------------------------------------------------------- | ------------------------ |
| Version, code, Bloks, app ID, signing, experiments, capabilities | Selected profile, always |
| `deviceString`, build, device ID, UUID, phone ID, advertising ID | Account, persisted       |
| Locale, timezone, radio/connection state                         | Account, persisted       |
| Cookies, authorization, claims, encryption key/key ID            | Server/session           |
| Pigeon/client session IDs, MQTT session ID, subscription IDs     | Transient                |

## 8. Existing-account behavior

A saved session keeps its identifiers and its **existing hardware**, including an
M1 Android 6–8.1 device. Only application fields change, to 448. No session file
is rewritten until the next normal save, which stores the same identity.

That continuity has a known structural problem: indexed Instagram 4xx builds
require Android 9, so `448 + Android 7.1.1` is a combination no real phone can
produce. The evidence is secondary, so M2 does not migrate silently. Instead the
report flags it (`App minimum: SDK 28 (not met by this device)`), and
`matchesSelectedProfile.device` is false for retained hardware.

Whether Instagram accepts an existing session after the app-level change, or
requires reauthentication, **cannot be determined offline**. Treat every existing
account as a reauthentication candidate. A device migration for such accounts
should be explicit, reversible (backup first), move device and build together,
and be decided in M3 alongside live authentication.

## 9. New-account behavior

A username with no saved session gets the template and username-derived
identifiers. After explicit logout (which deletes the session), the next login is
a new device. Tests assert that 100 synthetic new accounts never receive a 416
version, the old Bloks hash, an SDK 23–27 device, or a legacy build, and that the
identifiers are unique per username and stable across profile changes.

## 10. Unresolved constants and remaining inconsistencies

1. **Login flow.** Our dependency sends legacy `accounts/login/`; the maintained
   client is CAA/Bloks first. See section 11.
2. **Signing.** HMAC with the inherited v4 key and `ig_sig_key_version=4`, while
   instagrapi sends unsigned `SIGNATURE.` bodies. This is request behavior in the
   dependency, not a profile constant.
3. **Header set.** The dependency hard-codes `X-FB-HTTP-Engine: Liger`, versus
   `Tigon/MNS/TCP` in instagrapi. It also omits headers instagrapi sends, such as
   `X-IG-Family-Device-ID`, `X-MID`, `X-IG-Mapped-Locale`,
   `X-IG-App-Startup-Country`, `X-Bloks-Is-Panorama-Enabled`, `IG-INTENDED-USER-ID`
   and the bandwidth/zero-rating headers. Transport differs too (HTTP/1.1 versus
   HTTP/2 with TLS 1.3).
4. **Experiments.** The 814/88-entry lists come from the dependency's app-222 era.
5. **Release provenance.** 448.0.0.0.20 is probably a pre-release channel build;
   its official manifest code and minimum SDK are not APK-verified.
6. **Device age.** Android 14 with a September 2024 build is plausible, but not
   the Pixel 8 Pro's current OS. This keeps the maintained-client pairing.
7. **Existing hardware.** Retained legacy devices are below the app's minimum SDK
   (section 8).
8. **Country code** stays hard-coded to `1` in the login form.
9. **M1 carry-overs**: dormant FBNS identity, MQTT authorization-cache edges, and
   the `Number` → `BigInt` user-ID precision boundary (sections below).
10. **Web UA** keeps the inherited Chrome version; it has no active request path.

## 11. CAA implications and M3 recommendation

Evidence: instagrapi 3.0.0 (2026-09-13) made CAA/Bloks login the default
(`b.i.instagram.com/api/v1/bloks/async_action/com.bloks.www.bloks.caa.login.async.send_login_request/`).
Legacy `accounts/login/` is used only when Instagram returns
`CAA_LOGIN_FALLBACK`. Issues #2773, #2791 and #2807 show legacy login returning
`needs_upgrade` for some accounts/IPs even on current profiles, while the reported
448 successes came through the CAA-first flow. The selected profile is therefore
expected to be used with **CAA/Bloks login**, with legacy only as a
server-directed fallback.

**Recommendation for M3: B, implement CAA before live testing.** A legacy probe
(A or C) would spend a real login attempt on a path known to be gated, and each
failed attempt adds account risk (verification emails, 429s, checkpoints). The
profile's Bloks pairing exists precisely so CAA can use it. M3 should also decide
signing and the header set (items 2–3) and the existing-account device migration,
then run one controlled, explicitly authorized live attempt.

## 12. Procedure for future profile updates

1. Collect evidence for one release: version, runtime UA build and API Bloks
   version captured together, with source, commit and retrieval date. Do not
   combine values from different releases or from APK manifests/bundled assets.
2. Add a frozen `ApplicationRelease` to `declaredReleases`; never edit one field
   of an existing release.
3. Choose one device template whose SDK meets `minimumAndroidSdk`; verify model,
   codename, resolution and build against vendor documentation.
4. Update the independent literals in `profile.test.ts`, `rest.test.ts`,
   `mqtt.test.ts` and `report.test.ts` deliberately, and extend the legacy and
   new-account regression guards.
5. Keep the M1 fixtures. Run the old-session precedence tests.
6. Run complete isolated Node 22/24 gates and the focused harness commands below.
7. Record the change in this document and keep live validation a separately
   authorized step.

## Ownership and dependency boundaries

```text
InstagramCompatibilityProfile (profile.ts)
   release + device template + application constants
          ↓                                      ↓
applyCompatibilityProfile / restore       realtimeCompatibilityOptions
          ↓                                      ↓
IgApiClientExt.state ──────────────────→ RealtimeClient
          ↓                                      ↓
real REST repositories/request builder    real connection builder → Thrift
```

`createInstagramApiClient()` keeps `IgApiClientExt`, since `withRealtime()`
otherwise replaces an ordinary client. `applyCompatibilityProfile()` clones the
constants per instance and installs a non-enumerable web-UA accessor; no
prototype is modified and no session field is added. The original
`instagram-private-api` sample data and its MIT notice remain in
[`baseline-data.json`](../source/compatibility/baseline-data.json) and
[`NOTICE.md`](../source/compatibility/NOTICE.md); values borrowed from instagrapi
are attributed there as well.

The dependencies remain responsible for request behavior: endpoints, retries,
encoding and encryption, launcher configuration queries, topic/query IDs, and
response handling. Hosts, OTA query fields and the unused Orca application ID
`124024574287414` stay dependency constants.

## REST identity

The request builder derives `User-Agent` from app version, `deviceString`,
language and version code. `X-IG-App-ID`, `X-Bloks-Version-Id` and
`X-IG-Capabilities` read the configured state. Device headers use the UUID and the
`android-…` device ID; timeline also sends the advertising ID and UUID. Locale is
persisted account state. Signed forms carry `ig_sig_key_version` and
`signed_body=<HMAC>.<JSON>`. Login uses the real `#PWD_INSTAGRAM:4:` envelope and
fields `username`, `enc_password`, `guid`, `phone_id`, `_csrftoken`, `device_id`,
`adid`, `google_tokens`, `login_attempt_count`, `country_codes` and `jazoest`.
Without an encryption key, login first runs guest QE sync. Pre-login startup is
launcher sync; post-login cold start requests reels, then timeline.

Sanitized capture for a new account (identifiers redacted):

| Route               | Path                       | Identity                                                |
| ------------------- | -------------------------- | ------------------------------------------------------- |
| Login               | `/api/v1/accounts/login/`  | 448 UA, app ID, `0bc46a03…`, `3brTv10=`, signed v4      |
| Launcher sync       | `/api/v1/launcher/sync/`   | Same identity, signed v4                                |
| Experiment sync     | `/api/v1/qe/sync/`         | Same identity, signed v4                                |
| Reels cold start    | `/api/v1/feed/reels_tray/` | Same identity, unsigned; supported caps `119.0,…,142.0` |
| Timeline cold start | `/api/v1/feed/timeline/`   | Same identity, unsigned                                 |

## MQTT identity

Active realtime uses `cookie_auth`, the REST app UA in `clientInfo.userAgent` and
`appSpecificInfo['User-Agent']`, app version, capabilities and locale from the
same state, plus the profile's app ID and client capabilities via public
overrides. It uses the **phone ID** as `deviceId` and its first 20 characters as
`clientIdentifier`. Iris sends `snapshot_app_version` from the same state.

Sanitized capture: app ID `567067343352427`, app version `448.0.0.0.20`, the 448
UA above, `X-IG-Capabilities: 3brTv10=`, client capabilities `183`, endpoint
`0`, publish format `1`, stack `3`, topics `88, 135, 149, 150, 133, 146`.
Everclear query IDs and topic IDs stay in the library's protocol builders.

MQTT reads `parsedAuthorization` before `cookieUserId`, so a cookie can win over
an unparsed header, an authorization-only state needs priming, and a cached
parse can lag a changed header for one construction. The user ID passes through
`Number` before `BigInt`. **Unused FBNS** hard-codes app ID `567310203415052`,
endpoint capabilities `128`, `device_auth`, density `4.0` and ABI
`x86:armeabi-v7a`; it is characterized but outside the active adapter.

## Offline harness and sanitized report

[`tests/compatibility/`](../tests/compatibility/) has its own TypeScript project.
REST replaces `request`'s transport through request defaults, captures the fully
encoded request and throws a sentinel before any socket exists; repository logic,
signing, encryption and form encoding stay real. MQTT drives the real private
connection builder through a test-only bridge, serializes and decodes Thrift, and
never calls `connect()`. Workers deny HTTP, HTTPS, TLS, sockets and fetch, and
assert zero attempts. Application tests stub only the final login request and the
post-login setup.

```bash
mise exec node@22 -- npx --no-install tsc -p tests/compatibility/tsconfig.json --noEmit
mise exec node@22 -- npx --no-install ava 'tests/compatibility/*.test.ts'
```

[`compatibilityReport()`](../source/compatibility/report.ts) returns allowlisted
fields only, and `formatCompatibilityReport()` renders them:

```text
Instagram-CLI compatibility profile

Profile:            android-448.0.0.0.20-pixel-8-pro
Profile status:     selected
Profile source:     instagrapi 3.0.24 (a3b7538) app profile 448.0.0.0.20 and device settings; build from Google factory images
App version:        448.0.0.0.20
Version code:       1065560286
Bloks version:      0bc46a03e177bfc9bc8d611918815acf248fa9c77754d807d6a5951dc9ce9432
Android:            14 (SDK 34)
Device:             Google/google Pixel 8 Pro (husky; husky; 480dpi; 1344x2992; build AP2A.240905.003)
App minimum:        SDK 28 (met)
REST app ID:        567067343352427
REST capabilities:  3brTv10=
MQTT app version:   448.0.0.0.20
MQTT app ID:        567067343352427
Matches profile:    yes
Live validation:    not performed
```

It reads no files, sends nothing, and excludes credentials, authorization,
cookies, UUID/device/ad/phone IDs, session IDs, claims, encryption keys and
usernames. `insta-cli version` shows the profile ID; no other public command
exposes the report.

## Patch audit

| Patch hunk                                                          | Classification                               | Disposition                                                |
| ------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| `instagram-private-api` reply argument and imported type in `.d.ts` | Project integration behavior                 | Retained                                                   |
| `instagram-private-api` reply fields in `broadcastText()`           | Compatibility behavior / project integration | Retained; payload composition that state cannot express    |
| Pastel `exitOnCtrlC: false` (three renders)                         | Project integration behavior                 | Retained so this application controls full-screen teardown |

M1 removed the app version/code and Chrome version hunks. M2 added no patch and
no constant outside the profile architecture.
