# Sending a mainland relay's overseas traffic through Hong Kong

## The problem

Somebody in mainland China joins a meeting held on a relay abroad. What should
happen is that their media enters the country they are in — on Guangzhou or
Shanghai — and crosses the border once, on a link that is paid for and watched.

What happens instead is that they are moved to Hong Kong and connect to it
directly from their browser, because the pair Guangzhou–Singapore is written
down as one that does not carry. Measured from Guangzhou, on the relays' own
probe port, eight packets each:

| path             | direct        | via Hong Kong |
| ---------------- | ------------- | ------------- |
| Guangzhou → HK   | 11–14 ms      | —             |
| Guangzhou → SG   | 339–356 ms    | ~45 ms        |
| Guangzhou → JP   | 117–231 ms, 1 lost | ~60 ms   |
| Guangzhou → LAX  | 158–165 ms    | ~156 ms       |

So the rule is right — the direct pairs are bad — and the remedy of moving
people to Hong Kong is not the only one available.

## Measured, both ways

Set up between Guangzhou and Hong Kong for one destination and taken down again.
The application was not told anything and did not change: it went on addressing
Singapore, and the kernel sent the packets to Hong Kong.

| from Guangzhou, to Singapore's probe port | median |
| ----------------------------------------- | ------ |
| direct                                     | 346 ms |
| through Hong Kong                          | 45 ms  |
| direct again, after taking it down         | 343 ms |

A relay with no rule for it — Tokyo — stayed at 118 ms throughout, which is what
says the change was the rule rather than the day.

## Why this is routing rather than a feature

A TURN client makes one allocation. The browser allocates on Guangzhou, the
media server sends to that allocation, and the packets go Guangzhou to Singapore
by whatever route Guangzhou has. There is no field in which to say "and pass
through Hong Kong on the way": the protocol has one hop of relaying and this
deployment already uses it.

But which route Guangzhou takes is Guangzhou's own business. Give it a tunnel to
Hong Kong and a route for the overseas relays' addresses through that tunnel,
and the path is browser → Guangzhou → Hong Kong → Singapore while the client
still sees one hop. Nothing above the kernel changes.

## What this costs, and what it does not

It moves traffic that is already crossing the border onto a link that is 14 ms
away and does not drop packets, instead of one that is 340 ms away. It does not
add a hop that was not there — the packets were already going to Singapore, by a
worse road.

It does add a dependency: the Hong Kong machine now carries every mainland
participant's media for overseas meetings, in both directions, and its bill and
its uptime become the bill and uptime of that path. That is a decision about a
machine rather than about a protocol.

## Applying it

Two scripts, one per end, one destination at a time.

    # On the Hong Kong machine, once per overseas relay:
    viahk-hub.sh 39501 194.114.138.245 39218

    # On each mainland relay, the same pairing from the other side:
    viahk.sh 103.73.220.249 194.114.138.245 39218 39501

Both are idempotent and both take `off`. There is no tunnel and nothing is
installed: nftables rewrites the destination on the way out and the source on
the way back, so what leaves a mainland machine is ordinary UDP to another of
ours on a port we chose. A tunnel would have been tidier and would also have
been a protocol with a handshake somebody can fingerprint, which on a machine
rented in mainland China is a reason not to have one.

Verify with `dev/udpcheck` from the mainland relay before and after: the numbers
in the table above are what a working setup looks like.
