#!/bin/bash
# The Hong Kong end: take what a mainland relay sends and put it on the wire.
#
# One port per overseas relay, because that is the whole of the mapping — a
# packet arriving on this port is for that machine. No tunnel, no state to keep
# beyond what conntrack already keeps for any NAT.
#
#   viahk-hub.sh <listen-port> <dest-ip> <dest-port>
#
# Run again to change nothing. `off` removes it.
set -euo pipefail

TABLE="viahk"

if [ "${1:-}" = "off" ]; then
    nft delete table ip "$TABLE" 2>/dev/null && echo "removed" || echo "nothing to remove"
    rm -f /etc/sysctl.d/99-viahk.conf
    # Put the running value back too. Removing only the file leaves a machine
    # forwarding until its next reboot, which is the kind of leftover that is
    # found months later by somebody wondering why.
    sysctl -qw net.ipv4.ip_forward=0
    exit 0
fi

[ $# -eq 3 ] || { echo "usage: viahk-hub.sh <listen-port> <dest-ip> <dest-port>" >&2; exit 2; }

HPORT="$1"; DEST="$2"; DPORT="$3"

command -v nft >/dev/null || { echo "nftables is not installed" >&2; exit 1; }

# Forwarding, written down as well as set. A machine that forwards until its
# next reboot is a machine whose relays work until its next reboot.
printf 'net.ipv4.ip_forward = 1\n' > /etc/sysctl.d/99-viahk.conf
sysctl -qw net.ipv4.ip_forward=1

nft -f - <<EOF
table ip ${TABLE} {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;

        # Arriving here on this port means it is for that relay.
        udp dport ${HPORT} dnat to ${DEST}:${DPORT}
    }

    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;

        # Sent on as this machine, so the far end replies here and conntrack can
        # put the answer back on the path it came from. Without it the far end
        # would answer to a mainland address it has no reason to accept and no
        # route to reach.
        ip daddr ${DEST} udp dport ${DPORT} masquerade
    }
}
EOF

echo "listening ${HPORT} -> ${DEST}:${DPORT}"
nft list table ip "$TABLE" | sed 's/^/  /'
