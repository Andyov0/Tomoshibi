/**
 * Measuring the relays, so a call is held on whichever one is actually closest.
 *
 * A deployment can spread its media servers over several places and hand each
 * client to one of them. Which one is nearest is not something the server can
 * work out: it sees an address, and an address says where a network registered a
 * block, not how long a packet takes to get there. The browser about to make the
 * call is the only party that can answer, and it can answer by asking.
 *
 * So this opens the signalling socket to every relay at once, times it, and the
 * fastest name travels with the join. The server treats that name as a
 * preference and looks it up in its own list, so nothing here can send a meeting
 * anywhere the deployment did not already choose.
 *
 * Timed by opening the socket rather than by fetching a health endpoint, and the
 * health endpoint no longer exists. Two reasons, and the second is the one that
 * settled it. A WebSocket upgrade is the request a call actually begins with, so
 * it measures the thing being chosen between rather than something adjacent to
 * it. And a relay in mainland China is taken off the air by something that sends
 * an ordinary HTTPS request and reads the answer — an endpoint replying to
 * anybody who asks is that probe's evidence, served continuously and by us.
 */

/** One relay, as the control node describes it. */
export interface Relay {
	name: string;
	url: string;
	region?: string;
	/** What a person is shown instead of the name, which is a key and not a word. */
	label?: string;
	/** Held in reserve: it works, and every byte of a call on it goes the long way. */
	fallback?: boolean;
	/** Only administrators are offered it, and only they may ask for it. */
	adminOnly?: boolean;
	/** Where it answers STUN binding requests, as host:port. */
	probe?: string;
	/** Here, but not taking calls. Shown greyed rather than hidden. */
	maintenance?: boolean;
}

interface RelayList {
	relays: Relay[];
	/** Whether this deployment will act on a measurement. */
	measure: boolean;
}

/**
 * How long to wait for a relay before giving up on it.
 *
 * Short on purpose. This runs between somebody pressing join and their call
 * starting, and a relay that has not answered in a second and a half is not the
 * one to hold a conversation on. A relay that is merely slow to answer loses
 * only its place in this round; one that is down is skipped entirely and the
 * call goes elsewhere, which is the behaviour wanted from a timeout that sits in
 * front of a person waiting.
 */
const PROBE_TIMEOUT_MS = 1500;

/**
 * How long a measurement is trusted before it is taken again.
 *
 * Long enough that joining three rooms in a row does not measure three times,
 * short enough that a route which changed during a working day is noticed.
 * Kept in memory rather than in storage: a measurement is about the network this
 * tab is on, and a laptop that moved between two networks would otherwise carry
 * the old answer to the new one.
 */
const CACHE_MS = 5 * 60 * 1000;

let cached: { name: string; at: number } | undefined;

/** What the control node offers, or nothing if it does not answer. */
export async function relays(): Promise<RelayList> {
	try {
		const response = await fetch("/api/relays", { headers: { accept: "application/json" } });
		if (!response.ok) return { relays: [], measure: false };

		const body = (await response.json()) as Partial<RelayList>;

		return {
			relays: Array.isArray(body.relays) ? body.relays : [],
			measure: body.measure === true,
		};
	} catch {
		// A deployment that does not serve this endpoint is an older one, or a
		// full deployment holding its own media. Either way there is nothing to
		// choose between and the join proceeds exactly as it did before.
		return { relays: [], measure: false };
	}
}

/**
 * Time one relay, returning how long it took or nothing if it failed.
 *
 * Opened as a WebSocket rather than fetched over HTTPS, and the reason is not
 * that it is tidier. A relay in mainland China is probed by something that sends
 * an ordinary HTTPS request and reads what comes back; a port that answers is a
 * website, and an unregistered one is taken off the air. Every client measuring
 * every relay with a plain fetch before every join is that probe, arriving from
 * the deployment's own users, continuously.
 *
 * The upgrade is also the honest measurement. It is the exact request the call
 * is about to make, so what is timed is the path that will carry it rather than
 * one that merely runs alongside — a relay can serve a small GET quickly and
 * still refuse or stall the signalling socket.
 *
 * No token is sent, so the relay refuses and closes. That refusal is a complete
 * round trip, which is all this needs.
 */
/**
 * Time one round trip over UDP, the way the call will go.
 *
 * The other measurement below opens the signalling socket, which is TCP: a
 * handshake, a TLS handshake and an HTTP upgrade, so about three round trips
 * before anything comes back. It ranks relays correctly — every one pays the
 * same — and it reads as three times too slow, which is a number nobody
 * believes and therefore nobody uses.
 *
 * A browser cannot open a UDP socket, but it can be given a STUN server and
 * asked to find its own address, and the time to that answer is one round trip
 * on exactly the path the media will take. The relay answers binding requests
 * for this and nothing else.
 *
 * Nothing is connected and nothing is sent. The peer connection exists to make
 * the browser send one STUN request, and it is closed the moment the answer
 * comes back.
 */
function overUDP(relay: Relay): Promise<number | undefined> {
	if (!relay.probe) return Promise.resolve(undefined);

	return new Promise((resolve) => {
		let peer: RTCPeerConnection;
		try {
			peer = new RTCPeerConnection({
				iceServers: [{ urls: `stun:${relay.probe}` }],
				// Only the one server's answer is wanted. Left to itself the
				// browser would also gather host candidates, which cost nothing
				// but arrive first and would be timed instead.
				iceTransportPolicy: "all",
			});
		} catch {
			resolve(undefined);
			return;
		}

		const started = performance.now();

		let settled = false;
		const finish = (took: number | undefined) => {
			if (settled) return;
			settled = true;

			clearTimeout(timer);
			try {
				peer.close();
			} catch {
				// Already closing, which is one of the ways this ends.
			}

			resolve(took);
		};

		const timer = setTimeout(() => finish(undefined), PROBE_TIMEOUT_MS);

		peer.onicecandidate = (event) => {
			// The reflexive one, which is the relay's answer. Host candidates
			// are local and arrive immediately; relay candidates need TURN,
			// which this is deliberately not.
			if (event.candidate?.type === "srflx") finish(performance.now() - started);

			// End of gathering with nothing reflexive means no answer came.
			if (event.candidate === null) finish(undefined);
		};

		// A channel so there is something to gather for.
		try {
			peer.createDataChannel("probe");
			void peer.createOffer().then((offer) => peer.setLocalDescription(offer));
		} catch {
			finish(undefined);
		}
	});
}

function overSignalling(relay: Relay): Promise<number | undefined> {
	return new Promise((resolve) => {
		const started = performance.now();

		let socket: WebSocket;
		try {
			socket = new WebSocket(`${relay.url.replace(/\/+$/, "")}/rtc`);
		} catch {
			resolve(undefined);
			return;
		}

		let settled = false;
		const finish = (took: number | undefined) => {
			if (settled) return;
			settled = true;

			clearTimeout(timer);
			// Closed in every outcome. A socket left open holds a connection on a
			// relay this client may not even use, once per relay per join.
			try {
				socket.close();
			} catch {
				// Already closing, which is one of the outcomes that gets here.
			}

			resolve(took);
		};

		const timer = setTimeout(() => finish(undefined), PROBE_TIMEOUT_MS);

		// Either of these is the relay answering. `open` means it accepted the
		// upgrade; `close` arrives when it refused the missing token, which it
		// can only do after the same round trip. `error` fires alongside a close
		// for a refusal, so the timing is taken from whichever lands first.
		socket.onopen = () => finish(performance.now() - started);
		socket.onclose = () => finish(performance.now() - started);
		socket.onerror = () => finish(performance.now() - started);
	});
}

/**
 * Measure every relay at once and name the fastest.
 *
 * In parallel rather than in turn, because in turn the wait is the sum of every
 * relay's latency and the slowest one is paid for even though it will not be
 * chosen. In parallel it is the slowest single answer, bounded by the timeout
 * above.
 *
 * Returns nothing when there is nothing to choose or nothing answered. The
 * caller joins without a preference, and the server falls back to keeping the
 * room together — which is a worse route but a working call, and that is the
 * right trade for a measurement that did not come back.
 */
export async function fastest(list: Relay[]): Promise<string | undefined> {
	// Never the ones kept for administrators, and never one out of service.
	//
	// Automatic is for somebody who did not choose, so choosing something they
	// will be refused at the door is worse than not choosing at all — the
	// measurement would land on a relay reserved for somebody else and the join
	// would come back Access denied, for a machine they never asked for.
	//
	// An administrator who wants one asks for it by name, which is honoured.
	const usable = list.filter((relay) => !relay.adminOnly && !relay.maintenance);

	if (usable.length < 2) return usable[0]?.name;

	list = usable;

	const now = Date.now();
	if (cached && now - cached.at < CACHE_MS && list.some((relay) => relay.name === cached?.name)) {
		return cached.name;
	}

	const timings = await Promise.all(
		list.map(async (relay) => ({ name: relay.name, took: await probe(relay) })),
	);

	let best: { name: string; took: number } | undefined;
	for (const timing of timings) {
		if (timing.took === undefined) continue;
		if (!best || timing.took < best.took) best = { name: timing.name, took: timing.took };
	}

	if (!best) return undefined;

	cached = { name: best.name, at: now };
	return best.name;
}

/**
 * Time every relay and say how long each took, or nothing where it did not
 * answer.
 *
 * The same measurement [fastest] makes, kept rather than reduced to a winner.
 * Somebody choosing a relay by hand is entitled to the numbers the automatic
 * choice is made from — without them the picker is a list of place names, and
 * the person reading it is being asked to guess at exactly the thing this
 * already knows.
 *
 * Uncached on purpose. This runs because somebody opened the picker, which is
 * usually because the automatic answer has just disappointed them; handing back
 * a reading from five minutes ago would be answering a question they did not
 * ask.
 */
export async function timings(list: Relay[]): Promise<Map<string, number | undefined>> {
	const measured = await Promise.all(
		// Skipped for a relay out of service: it is shown so somebody can see it
		// is still there, and measuring a machine nobody may be sent to is a
		// connection spent on a number that cannot be acted on.
		list.map(async (relay) =>
			relay.maintenance
				? ([relay.name, undefined] as const)
				: ([relay.name, await probe(relay)] as const),
		),
	);

	return new Map(measured);
}

/**
 * Work out which relay to ask for, doing nothing when the deployment does not
 * want a measurement.
 *
 * The whole of what a join needs from this module. Failure at any point here is
 * answered with an empty preference rather than an error, because none of this
 * is required for a call to happen: it decides which of several working relays
 * is used, and a deployment with one relay, or none, is unaffected.
 */
export async function preferred(): Promise<string> {
	try {
		const offered = await relays();
		if (!offered.measure) return "";

		return (await fastest(offered.relays)) ?? "";
	} catch {
		return "";
	}
}

/** Forget the last measurement. Exported for tests. */
export function forget(): void {
	cached = undefined;
}

/**
 * Time a relay, over UDP where it will let us and over the socket otherwise.
 *
 * The UDP answer is one round trip and the TCP one is about three, so they are
 * not the same number and must not be mixed in one ranking — a relay that
 * answers STUN would beat a nearer one that does not, on nothing but the
 * measurement it happened to allow. Which is why this is chosen per list rather
 * than per relay: [timings] and [fastest] both ask for one kind and use it for
 * everybody, falling back only where no relay offers the better one.
 */
async function probe(relay: Relay): Promise<number | undefined> {
	if (relay.probe) {
		const took = await overUDP(relay);
		if (took !== undefined) return took;
	}

	return overSignalling(relay);
}
