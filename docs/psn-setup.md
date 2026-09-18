# PlayStation setup

The console screen discovers nearby consoles automatically. Select one to open
setup, connect a PSN account, then choose automatic pairing. If PSN pairing cannot
reach the console, the same dialog exposes Link Device PIN registration. Manual
IP entry, numeric/Base64 account IDs and public online-name lookup remain available.
Stream profiles are under Stream settings. Saved local login loads silently.

Local accounts remain in PostgreSQL, preserving existing users and registrations.
Switching to SQLite would not address session-loading UI and would require migrating
existing data. The HttpOnly session cookie lasts 400 days and every visit renews it. PostgreSQL data,
the signing secret and token-protection keys all persist in Docker volumes.

## Sony sign-in

Open the Sony sign-in link and enter credentials on Sony's page. Copy the final
Remote Play redirect URL back into this app, as in Chiaki's workflow. The browser
cannot read another origin's tab automatically. The server exchanges the code,
gets the numeric account ID and encodes eight little-endian bytes as Base64.
Sony passwords are never submitted to this app.

Access and refresh tokens are encrypted with ASP.NET Data Protection before saving
them in PostgreSQL. Keys persist under `/data/protection-keys` in `app-data`. Back
up both named volumes. Only account metadata reaches the browser. Forget account
removes the saved metadata and tokens; existing console registrations remain.

## Automatic pairing

A small native helper links Chiaki-ng's PSN registration protocol at revision
`a9a2805884cfa83865fdfcc09ca3ddfcd628aa42`. It lists PSN consoles, opens the PSN
control connection and runs registration without starting media playback. The
server matches the selected PS5 by name, requires a unique match, and verifies
its returned MAC against LAN discovery before saving the registration. PS4 uses
Chiaki's main-console route with the same final MAC check.

The selected PSN account must be present on the console with Remote Play enabled.
Sony availability, console settings and network traversal can prevent automatic
pairing. PIN registration remains the fallback. Playback still connects from the
Docker server directly to the LAN console using the existing CPU video/audio
pipeline; browser decoding remains software Canvas 2D.

The helper receives credentials over standard input, never command arguments.
One helper runs at a time, with bounded output and a 75-second process deadline.
The Docker image contains its license notices and downloadable corresponding
Chiaki/helper sources at `/native-psn-source.tar.gz`, linked in the page footer.

## API boundaries

All `/api/psn` endpoints require local authentication and return `Cache-Control: no-store`.

| Method and path | Request | Result |
|---|---|---|
| POST `/login` | Empty object | Sony login URL, random state bound to the local user |
| POST `/account` | `{redirectUrl}` | `{numericId, accountId, onlineId, canAutoPair}` |
| GET `/account` | — | `{account}` or `{account: null}` |
| DELETE `/account` | — | Removes this user's saved PSN account |
| POST `/lookup` | `{onlineId}` | Saved public metadata; `canAutoPair: false` |
| POST `/pair` | `{hostIp}` | Registered console identity, without keys |

Login attempts expire after ten minutes and are single-use. Callback host, path,
state and code are checked before contacting Sony. HTTP requests use fixed HTTPS
hosts, disallow redirects, cap response sizes and have deadlines. Automatic URL
logging is disabled because Sony's account endpoint includes an access token.

Public lookup sends only the entered online name to FlipScreen Games. The response
must match that name and contain a valid unsigned 64-bit ID. The provider was
returning HTTP 500 during validation; the app reports its unavailability and offers
Sony sign-in/manual entry. No credential is sent to the lookup provider.

## Verification limits

Fake-service tests cover OAuth state and response handling. Database integration
tests cover encrypted persistence, user isolation and registration storage.
Browser tests cover guided setup, silent login, automatic-pairing success/failure
responses, public lookup and PIN fallback. Real Sony sign-in and pinless registration
still require testing with the user's PSN account; synthetic tests do not establish
that Sony accepts the flow for every account or network.

Sources: [Chiaki setup](https://streetpea.github.io/chiaki-ng/setup/configuration/),
[Chiaki account exchange](https://github.com/streetpea/chiaki-ng/blob/a9a2805884cfa83865fdfcc09ca3ddfcd628aa42/gui/src/psnaccountid.cpp),
[Chiaki registration](https://github.com/streetpea/chiaki-ng/blob/a9a2805884cfa83865fdfcc09ca3ddfcd628aa42/lib/src/session.c),
[Sony online-ID rules](https://manuals.playstation.net/document/en/store/signup.html),
[FlipScreen lookup](https://psn.flipscreen.games/).

### Sony login errors

Sony can display “Something went wrong” or “Too many requests” before returning
an authorization code. This is also reported in
[Chiaki-ng issue 664](https://github.com/streetpea/chiaki-ng/issues/664).
The setup dialog includes a copyable login link and browser troubleshooting.
Try a private window, another browser, or complete setup on a phone/computer
using the same local account. Signing into PlayStation.com first in that browser
has helped some users. These are workarounds, not a server-side fix for Sony's
login service; the app cannot read or override the Sony page.
