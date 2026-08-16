/**
 * Measuring the relays, so a call is held on whichever one is actually closest.
 *
 * A deployment can spread its media servers over several places and hand each
 * client to one of them. Which one is nearest is not something the server can
 * work out: it sees an address, and an address says where a network registered a
 * block, not how long a packet takes to get there. The browser about to make the
 * call is the only party that can answer, and it can answer by asking.
 *
 * So each relay publishes an empty health endpoint, this measures every one of
 * them at once, and the fastest name travels with the join. The server treats
 * that name as a preference and looks it up in its own list, so nothing here can
 * send a meeting anywhere the deployment did not already choose.
 */

/** One relay, as the control node describes it. */
export interface Relay {
	name: string;
	url: string;
	region?: string;
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
 * The request is deliberately the smallest thing the relay serves: an empty 204
 * with no body to download, so what is measured is the round trip rather than
 * the size of an answer. Cache is bypassed for the same reason a stopwatch is
 * started before the race — a response served from cache would return instantly
 * and report a relay on another continent as the nearest one.
 */
async function probe(relay: Relay): Promise<number | undefined> {
	// The health endpoint sits beside the signalling one, on the same origin the
	// WebSocket will use, so the address is derived from it rather than
	// configured twice.
	const origin = relay.url.replace(/^ws/, "http").replace(/\/+$/, "");

	const control = new AbortController();
	const timer = setTimeout(() => control.abort(), PROBE_TIMEOUT_MS);

	const started = performance.now();

	try {
		const response = await fetch(`${origin}/api/health`, {
			method: "GET",
			cache: "no-store",
			signal: control.signal,
			// The relay answers any origin for this one path, so no credentials
			// are involved and none are sent.
			credentials: "omit",
		});

		if (!response.ok && response.status !== 204) return undefined;

		return performance.now() - started;
	} catch {
		// Aborted, refused, or blocked. All three mean the same thing here:
		// this is not the relay to hold a call on.
		return undefined;
	} finally {
		clearTimeout(timer);
	}
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
	if (list.length < 2) return list[0]?.name;

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
