# The mappings this deployment actually runs

Read off the machines rather than written from memory, which is where they lived
before this file: the rules are set at the moment a script is run and nothing
replays them, so the only record of which machine forwards what to where was the
running state of the machines doing it. A reboot removed both the rules and the
record at the same time.

`viahk-install.sh` is what makes them survive a reboot. Everything below is the
argument list to give it.

## The shape

Three legs, and the middle one is a hub in the opposite direction from the other
two, which is the part worth reading twice.

```
mainland relay ──► Hong Kong (103.73.220.249) ──► Singapore / Tokyo / Los Angeles / HK Dmit
Hong Kong      ──► Shanghai Tencent (122.51.197.228) ──► Shanghai Telecom (180.153.83.93)
```

Nothing in the scripts assumes which side is which. A machine is a hub because
something points at it.

## Ports

Two per destination, because a relay is reached at two ports and they are
measured and used separately:

| | |
| --- | --- |
| `39218` | The STUN probe port. What a browser times, and what `dev/udpcheck` asks. |
| `13378` | The media port. What a call is actually carried on. |

The hub ports are chosen so the destination is readable from the number:

| | |
| --- | --- |
| `395xx` | Probe traffic, one per overseas relay. |
| `3951x` | Media traffic, the same order. |
| `3954x` | Hong Kong's own traffic for Shanghai Telecom, through Shanghai Tencent. |

## Hong Kong — 103.73.220.249 (`Gomami-HK-AIO`)

Takes what the mainland relays send and puts it on the wire, and separately
sends its own Shanghai Telecom traffic through Shanghai Tencent.

```bash
viahk-install.sh hub \
  39501:194.114.138.245:39218 \
  39502:154.31.113.55:39218 \
  39503:38.175.108.159:39218 \
  39504:154.12.179.72:39218 \
  39511:194.114.138.245:13378 \
  39512:154.31.113.55:13378 \
  39513:38.175.108.159:13378 \
  39514:154.12.179.72:13378 \
  39541:122.51.197.228:39521 \
  39542:122.51.197.228:39531
```

The last two are the second leg. A packet arriving here for Shanghai Telecom is
sent to Shanghai Tencent's port for it, not to Shanghai Telecom — expressed as a
mapping rather than as a rule in the `output` chain, because forwarded packets
never reach `output` and putting it there took three relays from 348 ms to
answering nothing at all. The README records that at length.

## Shanghai Tencent — 122.51.197.228 (`sh.api.shota.sg`)

Both a spoke and a hub. Its own overseas traffic goes through Hong Kong; it also
carries Hong Kong's Shanghai Telecom traffic the last 6 ms.

```bash
viahk-install.sh spoke 103.73.220.249 \
  194.114.138.245:39218:39501 \
  154.31.113.55:39218:39502 \
  38.175.108.159:39218:39503 \
  154.12.179.72:39218:39504 \
  194.114.138.245:13378:39511 \
  154.31.113.55:13378:39512 \
  38.175.108.159:13378:39513 \
  154.12.179.72:13378:39514
```

and, for the leg it is the hub of:

```bash
viahk-install.sh hub \
  39521:180.153.83.93:39218 \
  39531:180.153.83.93:13378
```

Both are installed on the same machine and both are replayed at boot. The two
scripts own different chains of the same table, so installing one leaves the
other alone; `viahk-install.sh show` prints what a machine has.

## Guangzhou Tencent — 134.175.127.210 (`gz.api.shota.sg`)

The same spoke arguments as Shanghai Tencent. This is the machine the 7.9x
figure in the README was measured on.

```bash
viahk-install.sh spoke 103.73.220.249 \
  194.114.138.245:39218:39501 \
  154.31.113.55:39218:39502 \
  38.175.108.159:39218:39503 \
  154.12.179.72:39218:39504 \
  194.114.138.245:13378:39511 \
  154.31.113.55:13378:39512 \
  38.175.108.159:13378:39513 \
  154.12.179.72:13378:39514
```

## The destinations

| | | |
| --- | --- | --- |
| `194.114.138.245` | `sg.api.shota.sg` | Singapore Misaka |
| `154.31.113.55` | `jp.api.shota.sg` | Tokyo Dmit |
| `38.175.108.159` | `lax.api.shota.sg` | Los Angeles Misaka |
| `154.12.179.72` | `hkd.api.shota.sg` | Hong Kong Dmit |
| `180.153.83.93` | `shct.api.shota.sg` | Shanghai Telecom |

Addresses rather than names throughout, and deliberately: a name here would be
resolved on a mainland machine, and the whole reason several of these are dialled
by bare address is that the path filters the name.

## What installing these cost, once

Shanghai Tencent's hub rules were in the chain the spoke script rebuilds. The
hub script was changed at some point to use `hubpost` for exactly this reason —
so that each end can be rebuilt without flushing the other's rules — and that
machine had not had the hub script re-run since, so its masquerade rules were
still in `postrouting` under the old layout. Installing the spoke role rebuilt
`postrouting` and took them with it, and Hong Kong's path to Shanghai Telecom
went from working to silently unmasqueraded: the destination rewrite still
happened, Shanghai Telecom replied to Hong Kong directly, and Hong Kong has no
route that reaches it.

Found by counting the rules before and after, which is why the counting is
written down above. Installing the hub role put them back in the right chain,
and both roles now come back at boot.

The general lesson: `nft list table ip viahk` before, and again after, and the
line counts must match. A mapping that is quietly one rule short reads as
working right up until somebody says the meeting is bad.

## Checking it

From a mainland relay, before and after:

```bash
udpcheck 194.114.138.245:39218 154.31.113.55:39218 38.175.108.159:39218
```

`compare.py` measures both paths at once and is the honest version of this — one
port has a rule and one does not, so the same relay in the same minute gives a
reading each way. A before-and-after separated by a day compares two afternoons.

Reading the machines directly:

```bash
nft list table ip viahk
systemctl status viahk
```
