# meet-live

A video meeting server in one binary: the media server, the join endpoint, and
the client, compiled together.

```
main.go      Command dispatch, the embedded client, graceful shutdown.
internal/
  app/       HTTP surface: the client, the join endpoint, the signalling proxy.
  config/    One document split into this server's half and the media server's.
  rtc/       The embedded media server and a proxy to its loopback listener.
  room/      Room names, identities, and the tokens that authorise them.
  store/     A key-value file recording which rooms have been used.
  limit/     How fast rooms can be asked for.
web/         Vite, React, Tailwind, and the LiveKit client SDK.
dev/         Configuration for running it locally.
```

## Running it

```bash
cd web && bun install && bun run build
go build -o meet-live .
cd dev && ../meet-live meet.yaml
```

Open the printed URL and pick a room with `#/room-name`. Two tabs in different
windows are enough to have a call with yourself.

While working on the client, `bun run dev` proxies the API and the signalling to
a running server, so changes reload without recompiling anything.

## How it works

**The media server runs inside this process.** LiveKit ships as a library whose
server can be constructed and started directly, so `rtc.Start` builds one and
keeps it on the loopback interface. Three things follow, and they are the whole
reason for the arrangement:

- The token is signed with the same credentials, in the same process, that
  verify it. There is no shared secret to distribute and no second service whose
  configuration can drift out of step with this one.
- Deploying is copying one file. The client is compiled in, so there is no
  directory to ship beside the binary and nothing to get out of sync with it.
- One TCP port faces the network, and it is ours. The client, the API, and the
  signalling WebSocket share an origin, which is what makes this usable from
  another machine: camera access and secure WebSockets both need a secure
  context, and one origin means one certificate rather than two.

Signalling reaches the media server through a reverse proxy on the loopback
interface. The standard library carries a WebSocket upgrade through unchanged,
which is the only thing that path needs.

**A room is a name and nothing else.** There is no room object on the server and
no membership table. `POST /api/rooms/{room}/join` mints a token scoped to one
room and one identity, with no administrative rights, and a room exists because
somebody named it. Nothing has to be created first and nothing has to be cleaned
up after.

**Identity and display name are both signed in.** The identity comes back on the
next join so that reloading a tab keeps the same one, which is why a refresh does
not look like somebody leaving and a stranger arriving. The display name travels
with the request rather than being set after connecting, so it is there in the
first roster update and nobody can rename themselves to somebody else mid-call.

**The layout unit is a picture, not a person.** Somebody sharing their screen
while their camera is on contributes two, which is why `Surface` exists and why
every layout takes surfaces. A share auto-pins itself to the stage and releases
it when it stops, but only if the pin was automatic: a manual pin outranks the
automation in both directions.

**Subscription follows rendering.** A tile that is not on screen is not on the
wire either, and the layer that is sent matches the size of the element it is
going into. Both are the client SDK's own adaptive streaming, driven by the
video element rather than by anything this code decides. An earlier version
managed subscriptions by hand and got neither behaviour reliably; the two were
fighting for the same control.

**Joining is rate limited.** A room exists because somebody named it, so asking
for one nobody is using succeeds exactly like asking for a busy one. There is no
failure to count, which leaves the rate as the only thing between a script and
somebody else's meeting.

## Configuration

One file describes the whole process. The media server's loader rejects keys it
does not recognise, so the `meet` section is lifted out before the rest is handed
over. See `dev/meet.yaml`.

Two ports need to be reachable: the one under `meet.listen`, over TCP, and
`rtc.udp_port`, over UDP. A single UDP port rather than a range, because every
track is multiplexed onto it.

Behind a proxy, set `meet.trust_proxy` so that `X-Forwarded-For` and
`X-Forwarded-Host` are believed. Exposed directly they are whatever the caller
typed, and believing them would let anybody claim a fresh rate-limit budget per
request.

## Commands

```bash
meet-live [serve] [config.yaml]   Serve the client, the API, and the media
meet-live keygen                  Print a fresh API key and secret
meet-live rooms <database>        List the rooms a store has seen
```

`rooms` needs the server stopped: the store admits one process at a time. Live
occupancy is a different question with a different answer, and the media server
already knows it.

## Testing

```bash
go test ./...
cd web && bunx tsc --noEmit && bunx vitest run
```

The interesting behaviour needs two browsers and a running server, so it is
driven through headless Chrome with fake media devices rather than unit-tested.
Those scripts are not checked in; the flags that matter are
`--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`, and
each run should use a fresh room name so that a session which has not timed out
yet is not counted twice.

## What is not here

- **End-to-end encryption.** The SDK supports it; nothing here turns it on.
- **Chat, recording, and telephony.** All available from the media server, none
  wired up.
- **Accounts.** Everybody is a guest, and an identity lasts as long as the tab.
- **TLS.** Put a proxy in front for the web port; the UDP port needs none, since
  media is encrypted end to end regardless.
