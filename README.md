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

That also makes the name the credential, so arriving at the bare address
generates one rather than funnelling everybody into a shared default, which is a
room strangers walk into. Three words and four digits is 37 bits, drawn from
`crypto.getRandomValues`; guessed at the rate the server allows, stumbling onto
one of a few thousand rooms in use takes longer than anybody will spend. A name
somebody typed instead is short and meaningful, which is exactly what makes it
guessable, so the client says so about those and stays quiet about the rest.

**A name can be signed.** Anybody can call themselves anything, so `Alice#secret`
sends the passphrase with the join request and the server derives a short
signature from it, keyed with a file of its own. The signature goes into the
identity, which is signed into the token and enforced by the media server, so it
is not a claim travelling beside the name but part of what the participant
provably is. The same passphrase always signs the same, which is the whole point;
a different one signs differently and takes effect on the next join.

Two things follow from where the key lives. It is separate from the API
credentials because the two have opposite lifetimes: those should be rotated, and
rotating this one silently changes everybody's signature. And without it a
signature cannot be attacked offline at all, which is the difference between this
and the tripcodes it borrows its syntax from: the only way to find a passphrase
is to guess it through the join endpoint, where the rate limiter is waiting.

Somebody unsigned wearing a name that somebody else signed is marked, and nothing
else is. Two people genuinely called Alex is ordinary; impersonating a name
nobody recognises achieves nothing.

**Identity and display name are both signed in.** The identity comes back on the
next join so that reloading a tab keeps the same one, which is why a refresh does
not look like somebody leaving and a stranger arriving. The display name travels
with the request rather than being set after connecting, so it is there in the
first roster update and nobody can rename themselves to somebody else mid-call.

**The layout unit is a picture, not a person.** Somebody sharing their screen
while their camera is on contributes two, which is why `Surface` exists and why
every layout takes surfaces. A share auto-pins itself to the stage and releases
it when it stops, but only if the pin was automatic: a manual pin outranks the
automation in both directions. The stage offers a switch to that person's other
picture, so reaching their face during a share is one click rather than a hunt
through the filmstrip.

**The grid is chosen, not divided.** Splitting the container into equal cells is
what CSS does for free, and it gives two people on a wide screen a pair of tall
thin cells that crop a 16:9 picture down to a strip. Instead every column count
is tried and the one giving each person the most area wins, with the tiles
keeping their shape and the slack becoming space around them. Empty cells count
against an arrangement, so four people are never spread over six, and a ceiling
on height stops one participant filling the window edge to edge.

Clicking a tile puts it on the stage and clicking it again takes it back;
double-clicking fills the screen. Once there are more people than fit on a page,
whoever spoke most recently comes forward, since somebody talking from the second
page is somebody nobody can see. Below that threshold the order holds still,
because a grid that rearranges itself mid-sentence is worse than one that does
not.

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

**One signal colour.** Speaking, sharing, unread, copied — all amber, so at any
moment only one thing on screen is saying something. Red appears twice in the
whole application, on leaving and on errors; keyboard focus is white rather than
a second hue. Speaking is drawn as a line along the bottom edge of a picture
rather than a halo around it, opening from the centre and closing back to it, on
the model of the tally light that marks the live camera in a studio.

The neutrals lean warm. A blue-grey ground pushes skin tones towards green, and
this interface is a screen full of faces.

**A camera that is off shows who is missing, not what.** An avatar derived from
the identity: the same picture every time that person appears, different enough
between people that a grid of dark tiles is still a grid of individuals. Its
palette is muted on purpose — an avatar is content, standing in for video, but
it must never out-shout the tally.

**Notices say the four things worth interrupting for.** Somebody arriving,
somebody leaving, somebody else taking the stage with a share, and the two
failures a person can act on. A button somebody pressed is not reported back to
the person who pressed it, a copied link answers on the button itself, and a
connection that is down is a standing condition that belongs in the banner over
the stage rather than in something that fades.

**Messages arrive on the speaker's own picture.** A message is something a
person said, and the tile is already labelled with who they are, so the bubble
carries neither face nor name. Anybody with no tile to borrow — on another page,
or hidden behind a share — falls back to the corner, which is the only place a
message needs both. The panel that holds the whole conversation floats over the
room rather than pushing it aside: pushing would move and resize every tile at
once because one person wanted to type.

Nothing is written down. Messages last as long as the call, which is the same
rule the room follows, and the empty panel says so — whether that is true and
whether it looks true are different things, and only the second stops somebody
posting what they would rather not leave behind.

## Configuration

One file describes the whole process. The media server's loader rejects keys it
does not recognise, so the `meet` section is lifted out before the rest is handed
over. See `dev/meet.yaml`.

Two ports need to be reachable: the one under `meet.listen`, over TCP, and
`rtc.udp_port`, over UDP. A single UDP port rather than a range, because every
track is multiplexed onto it.

`meet.tripcode_key` names the file that signs passphrases. It is created on
first use and must not be replaced: doing so changes every existing signature.

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
- **Accounts.** Everybody is a guest. An identity lasts as long as the tab, and a
  signed name is the closest thing to a persistent one: it survives because the
  passphrase does, not because anything was stored.
- **TLS.** Put a proxy in front for the web port; the UDP port needs none, since
  media is encrypted end to end regardless. Until that is done the server is
  only usable from the machine it runs on: browsers withhold cameras and
  microphones outside a secure context, and only localhost is exempt. The client
  says so rather than failing, and the startup log qualifies the network address
  for the same reason.
