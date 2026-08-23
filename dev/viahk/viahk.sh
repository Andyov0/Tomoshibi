#!/bin/bash
# Send this relay's traffic to one overseas relay through Hong Kong.
#
# No tunnel and no new software. The kernel rewrites the destination on the way
# out and the source on the way back, so what leaves this machine is ordinary
# UDP to another of ours on a port we chose. A tunnel would have been tidier and
# would also have been a protocol with a handshake somebody can fingerprint,
# which on a machine rented in mainland China is a reason not to have one.
#
#   viahk.sh <hub-ip> <dest-ip> <dest-port> <hub-port>
#
# Run again to change nothing. Run with `off` as the first argument to remove it.
set -euo pipefail

TABLE="viahk"

if [ "${1:-}" = "off" ]; then
    nft delete table ip "$TABLE" 2>/dev/null && echo "removed" || echo "nothing to remove"
    exit 0
fi

[ $# -eq 4 ] || { echo "usage: viahk.sh <hub-ip> <dest-ip> <dest-port> <hub-port>" >&2; exit 2; }

HUB="$1"; DEST="$2"; DPORT="$3"; HPORT="$4"

command -v nft >/dev/null || { echo "nftables is not installed" >&2; exit 1; }

# Built whole and replaced whole. Adding rules to a table that may already have
# some is how a machine ends up with two of everything and no way to tell which
# one is in force.
nft -f - <<EOF
table ip ${TABLE} {
    chain output {
        # -100 rather than the name dstnat, which nftables only accepts on
        # prerouting. Same number, and the output hook is where a packet this
        # machine originated can still have its destination changed.
        type nat hook output priority -100; policy accept;

        # Anything this machine sends to the overseas relay goes to the hub
        # instead, on a port the hub has been told means that relay.
        ip daddr ${DEST} udp dport ${DPORT} dnat to ${HUB}:${HPORT}
    }

    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;

        # And leaves as this machine, so the hub answers to somewhere that has
        # a route back.
        ip daddr ${HUB} udp dport ${HPORT} masquerade
    }
}
EOF

echo "sending ${DEST}:${DPORT} via ${HUB}:${HPORT}"
nft list table ip "$TABLE" | sed 's/^/  /'
