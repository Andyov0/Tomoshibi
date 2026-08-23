# Running the media apart from the client

Upstream Tomoshibi is one process holding the media server, the API, and the
client. That is the right shape for one machine, and the wrong one as soon as
the media should live somewhere the client should not.

The two halves want opposite things. Media wants to sit close to the people
sending it, on a network chosen for its routes, and it is charged by the byte
wherever such networks are rented. The client is a few kilobytes and a
certificate, and any static host serves it for nothing. Held together they share
a machine, and it has to be the expensive one.

So the binary knows three roles, set under `meet.role`:

| role | serves | starts media | keeps a store |
|---|---|---|---|
| `full` (default) | client, joins, management, media | yes | yes |
| `relay` | signalling and media only | yes | no |
| `control` | client, joins, management | no | yes |

`full` is unchanged. A deployment that has not thought about this keeps working
exactly as it did.

## What each role refuses to be

A relay serves the signalling paths and a health endpoint, and nothing else. Not
"the client is unnecessary there" — it must not be present. A relay reachable at
a name somebody could type would otherwise serve a join endpoint signing tokens
against a store it does not keep, and management pages for administrators it was
never told about. The router returns early rather than skipping registrations
one at a time, so this cannot be half-true.

A control node starts no media server. The ports in its configuration are read
and never bound.

## The credentials are the join between them

One key pair, in every relay's configuration and in the control node's. The
control node signs a token with it; the relay the client then dials verifies
with the same one. There is no second secret and nothing to keep in step —
which is the property that made a single binary possible upstream, kept intact
across the split.

Generate a pair with `tomoshibi keygen` and put the same one everywhere.

## Redis

Every relay and the control node point at one instance. It is what lets the
relays route between themselves, so a meeting whose participants landed on
different relays can still hear itself.

Without it each relay is an island. A call works only when everybody in it
reached the same one — which the `sticky` policy arranges deliberately and the
`probe` policy deliberately does not. The server says so at startup rather than
letting the first split meeting be the way anybody finds out.

## Choosing a relay

`meet.relay_policy`, on the control node:

**`sticky`** (the default) hashes the room name. Everybody in one room goes to
one relay, so media between two participants never leaves it. On metered egress
this is the cheapest thing to do, because media crossing between relays is
carried twice: once to cross and once to deliver.

The hash is FNV rather than maphash, which is seeded per process. Two control
nodes behind one address must send the same room to the same relay, and a
control node restarted in the middle of a meeting must not start sending the
second half of the participants somewhere else.

**`probe`** asks the browser. Where a client should connect is not something a
server can work out — it sees an address, and an address says where a block was
registered, not how long a packet takes to get there. The browser about to make
the call can simply measure.

Each relay publishes an empty `GET /api/health`, answered for any origin so it
can be timed by a page served from the control node. The client fetches
`/api/relays`, times all of them at once, and sends the fastest name with its
join.

What travels is a name from the list it was given and never an address. A forged
one selects a different relay of the deployment's own at worst; an unknown one
is ignored and the client lands on the room's relay like anybody who did not
measure. Measuring is bounded at a second and a half per relay, runs in
parallel, is cached for five minutes in memory, and failure anywhere is answered
with no preference at all. It decides which of several working relays is used
and can never stop a call from happening.

**`nearest`** reads `X-Client-Region`, or Cloudflare's `CF-IPCountry`, and
matches it against each relay's `region`. Only believed when `trust_proxy` is
set, for the same reason the forwarded address is: a header nobody upstream
overwrites is whatever the caller typed. Falls back to `sticky` when nothing
matches, rather than to the first entry — falling to the first would gather
every unlabelled client onto one relay.

**`round_robin`** spreads clients over the relays in turn, ignoring both room and
region.

## Deploying

`dev/relay.yaml` and `dev/control.yaml` are working examples.

On each relay:

```
tomoshibi /etc/tomoshibi/relay.yaml
```

Open the TCP port under `meet.listen` and the UDP port under `rtc.udp_port`.
Set `rtc.use_external_ip: true` — left false a relay hands out an address only
it can reach, and every connection fails after appearing to succeed. The server
warns about this at startup.

On the control node:

```
tomoshibi /etc/tomoshibi/control.yaml
```

Put it behind TLS. Cameras and secure WebSockets both need a secure page, and
browsers exempt only localhost.

## A relay reached by address rather than by name

Some paths refuse a relay by the name in the TLS handshake and by nothing else.
It is worth being precise about that claim, because it is easy to make loosely,
and easy to check: dial the same address on the same port and change only the
name offered in the handshake. `dev/snicheck` does that.

Measured from Singapore, six rounds per name, against one of these machines:

| name offered            | handshakes finished |
| ----------------------- | ------------------- |
| (none)                  | 6/6                 |
| a name it once answered to | 2/6              |
| another it once answered to | 0/6             |
| a name never used       | 6/6                 |

So the filtering follows the name, it is intermittent — a single attempt would
have found any of those answers and reported it as the whole truth — and a name
that has not been used yet is clean until it has been.

A relay in that position is configured with a bare address in its URL, which
costs three things and is worth them:

- **The address is visible.** It is in the join response and in any browser's
  network panel. There is no version of not sending a name that also hides where
  the machine is.
- **The certificate is its own.** A wildcard for a domain cannot answer for an
  address, so the machine issues one for its own address — short-lived, six
  days, renewed by an acme client on the machine itself. The fleet-wide
  certificate push refuses to overwrite it: a renewal never narrows what a
  certificate answers to, whatever its expiry says.
- **Nothing else can renew it.** The control node reads back what each relay is
  serving and says so every round, and warns when one is under two days out.
  That is the whole of watching it, and the message names the machine.

Set the acme client's reload command to fix the file's group and mode and
nothing else. Restarting the relay drops every call on it, and the server
re-reads its certificate on the next handshake — a renewal every two days
should not cost a call every two days.

The alternative — rotating to a fresh name each time one is filtered — works, is
cheaper to operate, and was not chosen: a name that has not been used yet is
clean because it has not been used yet, and the rotation is a schedule somebody
has to keep against an adversary who does not.

## What it costs

A relay carries every byte of every call held on it. That is the point of
putting it where the routes are good, and it is also the whole of the bill on a
host that charges for egress. `sticky` is the policy that minimises it; `probe`
trades some of it for latency, and needs redis to do so.

## What a control node going away costs

Measured rather than reasoned about, because the answer decides how much the
control node's stability matters. It was stopped for sixty seconds during a call
between two people on the same relay.

The call did not notice. Both ends stayed `connected` with no reconnection
event, and traffic went on flowing throughout — one participant's counters moved
from 1.7 MB to 21.6 MB across the outage. Nothing about a call in progress goes
through the control node: it signs the token at the door and the media server
holds everything after that.

What does stop is joining. A token cannot be signed, so nobody new gets in until
it is back — and when it came back, a third person joined normally and was sent
to the relay already holding the room.

The one thing a client asks for mid-call is who the host is, polled from
`/api/rooms/{name}/host`. It fails quietly and keeps the last answer, so a host
panel goes stale rather than a call going down.
