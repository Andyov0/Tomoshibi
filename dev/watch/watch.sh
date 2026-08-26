#!/bin/bash
# What this deployment notices, put in front of a person.
#
# Everything below is something the server already works out and writes to its
# journal, where nobody is reading. A relay whose media port has stopped
# answering, a certificate two days from running out, a store that has been
# emptied — each of them says so once, correctly, to a log on one machine among
# eleven. That is not noticing.
#
# Only what cannot fix itself. A relay that goes quiet for a sweep comes back; a
# control node whose own line drops sees the whole fleet fail at once and holds
# its readings rather than acting on them. Both are ordinary and neither is
# worth a message. So a fault has to survive several rounds before anything is
# sent, and a fault that persists is repeated at an hour rather than every five
# minutes — the point is that a message from this means something, and a person
# who has learnt to swipe them away has been trained by the wrong messages.
#
# Run from cron on the control node, every five minutes:
#
#   */5 * * * * /usr/local/bin/tomoshibi-watch
#
# The bot token is not here and never comes here. This posts text to the Hermes
# machine over the private network and that machine, which already holds the
# token, does the talking.
set -uo pipefail

AT=${AT:-http://127.0.0.1:8080}
SAY=${SAY:-http://114.51.4.11:49771/say}
WORD=${WORD:-}

STATE=${STATE:-/var/lib/tomoshibi-watch}
LOG=${LOG:-/var/log/tomoshibi-watch.log}

# How many rounds a fault has to survive before anybody hears about it, and how
# often to repeat one that will not go away. Three rounds is fifteen minutes,
# which is longer than any of the self-healing this deployment does.
QUIET_FOR=${QUIET_FOR:-3}
REMIND_EVERY=${REMIND_EVERY:-12}

# Where the session for the management API comes from. A read-only
# administrator is enough and is what should be used: nothing here changes
# anything.
ENV_FILE=${ENV_FILE:-/etc/tomoshibi/watch.env}

# The word this and the relay on the Hermes machine share, kept beside the
# management credential rather than in the crontab, where a `ps` would show it.
if [ -z "$WORD" ] && [ -f "$ENV_FILE" ]; then
    WORD=$(grep -m1 '^WORD=' "$ENV_FILE" | cut -d= -f2-)
fi

mkdir -p "$STATE"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

# The log is written every five minutes for ever.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1048576 ]; then
    tail -c 200000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

say() {
    local body
    body=$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1], "word": sys.argv[2]}))' \
        "$1" "$WORD" 2>/dev/null) || return 1

    curl -s --max-time 20 -o /dev/null -X POST "$SAY" \
        -H 'Content-Type: application/json' --data-binary "$body"
}

# One counter per kind of fault, so that a relay being down does not silence a
# certificate that is about to expire.
#
# Returns 0 when this round is worth saying out loud.
worth_saying() {
    local kind=$1 wrong=$2
    local file="$STATE/$kind"
    local seen=0

    [ -f "$file" ] && seen=$(cat "$file" 2>/dev/null || echo 0)

    if [ "$wrong" -eq 0 ]; then
        # Recovered. Said once, because "it is better" is worth as much as "it
        # is broken" to somebody who was told the first thing.
        if [ "$seen" -ge "$QUIET_FOR" ]; then
            rm -f "$file"
            return 2
        fi

        rm -f "$file"
        return 1
    fi

    seen=$((seen + 1))
    echo "$seen" > "$file"

    [ "$seen" -lt "$QUIET_FOR" ] && return 1
    [ "$seen" -eq "$QUIET_FOR" ] && return 0
    [ $(( (seen - QUIET_FOR) % REMIND_EVERY )) -eq 0 ] && return 0

    return 1
}

session() {
    [ -f "$ENV_FILE" ] || return 1

    local name secret
    name=$(grep -m1 '^WATCH_NAME=' "$ENV_FILE" | cut -d= -f2-)
    secret=$(grep -m1 '^WATCH_PASSPHRASE=' "$ENV_FILE" | cut -d= -f2-)
    [ -n "$name" ] && [ -n "$secret" ] || return 1

    python3 - "$AT" "$name" "$secret" <<'PY'
import json, sys, urllib.request
at, name, secret = sys.argv[1:4]
body = json.dumps({"name": name, "passphrase": secret}).encode()
request = urllib.request.Request(
    at + "/api/admin/session", data=body, headers={"Content-Type": "application/json"})
try:
    with urllib.request.urlopen(request, timeout=15) as answer:
        for header in answer.headers.get_all("Set-Cookie") or []:
            print(header.split(";")[0])
            break
except Exception:
    sys.exit(1)
PY
}

COOKIE=$(session) || COOKIE=""

if [ -z "$COOKIE" ]; then
    log "could not sign in to the management API; only the log is being read"
fi

# ---------- the fleet ----------
#
# Read from the management API rather than by asking each relay, because that is
# the reading the control node acts on: a relay this node cannot reach is one it
# will not send anybody to, whatever the relay itself thinks.
FLEET=""
if [ -n "$COOKIE" ]; then
    FLEET=$(curl -s --max-time 20 -H "Cookie: $COOKIE" "$AT/api/admin/relays" 2>/dev/null)
fi

DOWN=""

if [ -n "$FLEET" ]; then
    DOWN=$(python3 - <<'PY' "$FLEET"
import json, sys
try:
    relays = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
if isinstance(relays, dict):
    relays = relays.get("relays", [])
# Out of service on purpose is not a fault. Somebody took it out.
print(", ".join(
    r.get("name", "?") for r in relays
    if r.get("enabled") and not r.get("reachable")))
PY
)
fi

# ---------- what the server said ----------
#
# The journal, for the things that have no endpoint: a certificate about to run
# out on a machine this node cannot renew for, a store that opened empty, a copy
# that could not be written. Each is a line the server already writes.
recent() {
    journalctl -u tomoshibi --since '-6min' --no-pager 2>/dev/null | grep -c "$1" || true
}

CERT=$(recent 'serving a certificate that expires soon')
EMPTY=$(recent 'the store is empty and there are copies')
NOCOPY=$(recent 'could not copy the store')
NOMEDIA=$(recent 'its media port does not answer')

# ---------- deciding ----------
trouble=0
lines=""

add() { lines="${lines}$1"$'\n'; trouble=1; }

if [ -n "$DOWN" ]; then
    worth_saying relays 1 && add "🔴 <b>Relays not answering</b>: ${DOWN}"
    log "relays down: $DOWN"
else
    worth_saying relays 0
    [ $? -eq 2 ] && say "🟢 <b>Every relay is answering again</b>"
fi

if [ "${NOMEDIA:-0}" -gt 0 ]; then
    worth_saying media 1 && add "🔴 <b>A relay answers signalling but not media</b> — calls sent there connect and have no sound or picture. Look at what is allowed through to its probe port."
    log "media port unreachable on some relay"
else
    worth_saying media 0
    [ $? -eq 2 ] && say "🟢 <b>Media ports are answering again</b>"
fi

if [ "${CERT:-0}" -gt 0 ]; then
    # No self-healing window for this one: it is already a warning about
    # something that will not fix itself, said two days ahead.
    worth_saying cert 1 && add "🔴 <b>A relay's certificate runs out within two days</b> and this node cannot renew it. Look at the acme client on that machine."
    log "certificate expiring on a relay"
else
    worth_saying cert 0
fi

if [ "${EMPTY:-0}" -gt 0 ]; then
    add "🔴 <b>The store opened empty and there are copies beside it</b> — this deployment held relays, accounts and administrators and no longer does. Stop the service and put back the newest copy."
    log "store opened empty"
fi

if [ "${NOCOPY:-0}" -gt 0 ]; then
    worth_saying backup 1 && add "🟠 <b>The store could not be copied</b> — there will be nothing to restore from."
    log "backup failed"
else
    worth_saying backup 0
fi

if [ "$trouble" -eq 0 ]; then
    log "well"
    exit 0
fi

say "$(printf '%s\n%s' "$lines" "$(date '+%F %T')")"
exit 1
