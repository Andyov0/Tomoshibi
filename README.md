# Tomoshibi

A video meeting server in one binary. The media server, the API, and the client
are compiled together into a single file: deploying is copying it to a machine
and running it, and there is nothing beside it to keep in step.

Somebody opens a link, is shown their own camera, types a name, and is in a
call. Nobody registers, and there is no account to lose. What it does have is a
way of proving a name — a passphrase turns one into a name nobody else can wear
— a management surface for whoever runs the deployment, and a switch that limits
new rooms to the people on that list.

`tomoshibi` is Japanese for a small light left burning: a lamp in a window,
enough for the people who need it and no brighter.

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

## Building it

Go 1.26 and pnpm. The client is compiled into the binary, so it is built first
and every time; a stale `web/dist` is a stale application with no sign of it.

```bash
cd web && pnpm install && pnpm run build && cd ..
go build -o tomoshibi .
```

For something to hand to a server, strip the symbol table and the build id. The
last of those is what makes two builds of one commit byte-identical, which is
the only way to tell whether a binary on a machine is the one that was meant to
be there.

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -ldflags="-s -w -buildid=" -o tomoshibi .
```

## Running it

```bash
cd dev && ../tomoshibi meet.yaml
```

Open the printed URL and pick a room with `#/room-name`. Two tabs in different
windows are enough to have a call with yourself.

While working on the client, `pnpm run dev` proxies the API and the signalling
to a running server, so changes reload without recompiling anything.

## Deploying it

Two ports have to be reachable, and only two:

| Port | Protocol | What it carries |
| --- | --- | --- |
| `meet.listen` | TCP | The client, the API, and the signalling WebSocket |
| `rtc.udp_port` | UDP | Every track, from everybody, multiplexed onto one port |

Put a reverse proxy in front of the TCP one and give it a certificate. This is
not a preference: browsers withhold cameras and microphones outside a secure
context, and only `localhost` is exempt, so an unproxied deployment is usable
from the machine it runs on and nowhere else. The UDP port needs no certificate
— media is encrypted end to end regardless — and must not be proxied.

A working deployment, then, is four files and a service:

```
/usr/local/bin/tomoshibi          the binary
/etc/tomoshibi/meet.yaml          the configuration
/var/lib/tomoshibi/meet.db        the store, created on first run
/var/lib/tomoshibi/tripcode.key   the signing key, created on first run
```

```ini
[Unit]
Description=Tomoshibi
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/tomoshibi serve /etc/tomoshibi/meet.yaml
WorkingDirectory=/var/lib/tomoshibi
Restart=on-failure
RestartSec=2

# Nothing here needs a privileged port, a shell, or anybody else's files.
DynamicUser=yes
StateDirectory=tomoshibi
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

The configuration it wants:

```yaml
port: 7880
bind_addresses: ["127.0.0.1"]

rtc:
  udp_port: 7882
  tcp_port: 7881
  # True on any machine with a public address. False hands participants an
  # address only the host can reach, and the call connects to nothing.
  use_external_ip: true

keys:
  # Generate a real pair with `tomoshibi keygen`. These are one secret rather
  # than two: the same process signs and verifies with them.
  APIyourkey: your-secret

meet:
  listen: ":8080"
  database: /var/lib/tomoshibi/meet.db
  tripcode_key: /var/lib/tomoshibi/tripcode.key

  # The address clients are told to dial, when it is not the one they arrived
  # at. Needed behind a proxy.
  public_url: https://meet.example.com

  # Only behind a proxy that sets them. Exposed directly they are whatever the
  # caller typed, and believing them hands anybody a fresh rate-limit budget.
  trust_proxy: true
```

Upgrading is replacing the binary and restarting. The running one holds the
file open, so write beside it and move it into place:

```bash
scp tomoshibi server:/usr/local/bin/tomoshibi.new
ssh server 'mv /usr/local/bin/tomoshibi.new /usr/local/bin/tomoshibi \
  && systemctl restart tomoshibi'
```

Nothing in the store needs migrating between versions. A record a build cannot
read is treated as one that is not there, which is affordable because none of it
is authoritative: who is in a room is the media server's to know, and a token is
signed rather than stored.

## Administrators

There are no accounts. An administrator is a signature listed in the
configuration file — the same signature their passphrase already produces beside
their name in every room they join.

```bash
tomoshibi admin new /etc/tomoshibi/meet.yaml
```

```
passphrase  7mrdz-nlq32
trip        5dtfc2ouiu
```

The passphrase goes into a password manager and the trip goes into the file. The
passphrase is not stored anywhere and cannot be recovered; the trip is public and
grants nothing, which is the whole reason it is the half that gets written down.

```yaml
meet:
  admins:
    - trip: 5dtfc2ouiu
      name: adam
      can: [moderate]
```

`can` is empty for somebody who may only watch: the readings, the trend, the
health checks, and who is in which room. `moderate` adds the actions — removing
a participant, muting a track, closing a room, and changing who may open one.
Two levels rather than one, because binding them together makes the choice
"everybody gets the dangerous half, or nobody gets the useful one".

Restart, and `/admin` exists. Where no administrator is listed it does not: the
address answers like any other nobody claimed, so there is no sign-in page on a
deployment with nobody to sign in.

To sign in, type the passphrase. `adam#7mrdz-nlq32` is accepted too, because that
is the form this application teaches everywhere else.

Somebody who has already joined a call has their trip printed beside their name,
and the management pages will copy it: right-click their picture and take **Copy
the signature**. That is the string to paste into the file.

## Letting only administrators open rooms

A room here is a name and nothing else — there is no object to create — so the
question this answers is *who may be the first to use a name*. Names already in
use are untouched, which means a meeting in progress can never be interrupted by
it, and everybody who has the link still gets in.

From the management pages: **Rooms**, then **New rooms**, then
**Administrators**. It takes effect at once and needs no restart.

To have a deployment start that way, set the value the store adopts on its first
run:

```yaml
meet:
  rooms:
    opened_by: admins   # or `anyone`, which is the default
```

Rooms age out. A name nobody has joined for `meet.rooms.remember` — thirty days
by default, `0` to keep them for ever — is forgotten, and is a name nobody has
used again. That is one setting doing two things that happen to agree: a name was
written down the first time somebody joined it and nothing ever took one away, so
the store grew for as long as anybody asked it for names, bounded by the rate
limiter in how fast and by nothing in how many. And a name nobody has spoken in a
month is not a room in use — calling it one leaves a room open for good because
somebody said its name once, last year.

The sweep runs hourly in bounded passes, because the store admits one writer and
a join is a write: clearing a neglected file in a single transaction would make
everybody joining a call wait behind it.

That is the starting value only. The management pages change it afterwards and
cannot edit a file, so the choice lives in the store from then on; the runtime
panel shows the file's value beside the one in force, so a file edited later is
visibly not being obeyed rather than puzzlingly ignored.

Asking for `admins` where nobody is listed as an administrator is a rule nothing
could satisfy — every new name would be refused for good, and the pages that
could undo it would not exist either — so it is read as `anyone` and said so at
startup.

An administrator opens a new room by joining it with their passphrase, in the
passphrase field on the join page. Everybody else is told the room has not been
opened and to ask whoever is holding the meeting for the link.

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

**Everybody carries a mark; not every mark proves anything.** Anybody can call
themselves anything, so a passphrase is sent with the join request and the
server derives a short mark from it, keyed with a file of its own. Somebody who
gives no passphrase is issued one instead, drawn from nothing and fresh each
visit — without it, two people arriving under one name are indistinguishable and
the roster cannot say which of them spoke.

The passphrase has a field of its own, which is less a matter of taste than it
sounds. It used to be the half of the name field after a hash, and no password
manager on earth can see that — not the browser's, not the one in the extension
bar — so the thing every person was asked to remember was the one thing nothing
was allowed to remember for them. It is a password field with an autocomplete
attribute now, and Chromium is additionally offered the credential outright,
since a page that never navigates never gives its heuristic the submission it
watches for. `Alice#secret` still works and is no longer advertised: a syntax
that quietly stops being accepted is worse than one that is no longer mentioned.

The two kinds must never look alike, or the earned one is worth nothing: an
impostor would point at their own and claim it. So they wear different prefixes
on the identity, which its bearer cannot choose, and the interface draws an
earned mark at reading weight behind a leading dot while an issued one is
dimmer and has none — a serial number rather than a claim about who somebody
is. The same passphrase always earns the same mark, which is the whole point; a
different one earns a different mark and takes effect on the next join.

The mark goes into the identity, which is signed into the token and enforced by
the media server, so it is not a claim travelling beside the name but part of
what the participant provably is.

Two things follow from where the key lives. It is separate from the API
credentials because the two have opposite lifetimes: those should be rotated, and
rotating this one silently changes everybody's signature. And without it a
signature cannot be attacked offline at all, which is the difference between this
and the tripcodes it borrows its syntax from: the only way to find a passphrase
is to guess it through the join endpoint, where the rate limiter is waiting.

Somebody who cannot prove a name that another participant has proven is marked,
and nothing else is. Two people genuinely called Alex is ordinary; impersonating
a name nobody recognises achieves nothing.

**Identity and display name are both signed in.** The identity comes back on the
next join so that reloading a tab keeps the same one, which is why a refresh does
not look like somebody leaving and a stranger arriving. The display name travels
with the request rather than being set after connecting, so it is there in the
first roster update and nobody can rename themselves to somebody else mid-call.

**How loud everybody is is one person's own decision.** A sound panel lists what
can be heard rather than who can be seen — sound is rendered outside the stage on
purpose, so the person who is too loud is as likely as not to be on the second
page — with a row per thing there is to hear: somebody's voice, and separately the
sound of a screen they are sharing, because those were always two tracks.
Stopping one asks the media server to stop sending it rather than turning it down
here, which is the difference between hearing nothing and paying for it anyway.

Neither of the media library's own places for this remembers. A volume lives on
the remote participant and a block on the publication, and a full reconnect
rebuilds every participant while a restarted share is a new publication — so the
setting is kept here and put back whenever the room changes underneath. It is
also what a mark is for: a setting is written down only against a proven
signature, which is the same string next week, while a guest's lasts the call
because there is no persistent them to remember.

A picture whose sound has been silenced says so, and that mark outranks the one
saying its owner muted themselves. Both mean no sound; only one of them is
something the person looking can undo.

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

Addresses in a message are clickable, in the bubble as well as the panel, since
a link is the commonest thing anybody types during a call. Only complete `http`
and `https` URLs are matched: guessing at bare hostnames turns an ordinary
sentence into a link to somewhere nobody meant, and a false link is worse than a
missed one because it is clickable and looks deliberate.

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

`meet.rooms.opened_by` is who may use a name nobody has used before — `anyone`,
which is the default and what an anonymous meeting link means, or `admins`,
which refuses one unless the passphrase sent with the join belongs to somebody
listed under `meet.admins`. A name already in use is untouched by either: a
meeting in progress is never interrupted by this, and everybody who has the name
still gets in.

It is the starting value only. The management pages change it, and cannot edit a
file, so the choice is kept in the store and the file is what the store adopts on
first run. Editing it afterwards does nothing; the runtime panel shows the file's
value beside the one in force so the difference is visible rather than puzzling.

Asking for `admins` where nobody is listed as one is a rule nothing could satisfy
and every new name would be refused for good, so it is read as `anyone` and said
so at startup.

## Commands

```bash
tomoshibi [serve] [config.yaml]   Serve the client, the API, and the media
tomoshibi keygen                  Print a fresh API key and secret
tomoshibi rooms <database>        List the rooms a store has seen
tomoshibi admin new [config.yaml] Make an administrator's passphrase and trip
tomoshibi admin trip [config.yaml] <passphrase>
                                  Work out the trip a passphrase already gives
```

`rooms` needs the server stopped: the store admits one process at a time. Live
occupancy is a different question with a different answer, and the media server
already knows it.

## Testing

```bash
go test ./...
cd web && pnpm run check && pnpm test
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

## Licence

[GNU Affero General Public License, version 3 or later](LICENSE).

The Affero clause is the one that matters for something like this. A meeting
server is used over a network and never distributed, so an ordinary copyleft
licence would place no obligation on anybody running a changed copy: they would
owe their participants nothing, and the participants would have no way of asking.
Section 13 closes that — whoever offers this over a network owes its source to
the people using it that way.

Which is why the join page carries a link to it. Set `meet.source_url` to
wherever a changed copy lives; a link to somebody else's repository is not an
offer of the code anybody is actually running.

The embedded media server is LiveKit, under Apache-2.0, and everything the client
is built from is MIT or ISC. All of them may be carried by an AGPL work.
