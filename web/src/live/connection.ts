/**
 * How the call is actually going, measured rather than assumed.
 *
 * Somebody whose picture is breaking up wants to know one thing before anything
 * else: is it me, or is it them. Nothing on the screen answered that. The
 * meeting either looked fine or looked bad, and every explanation for looking
 * bad — a slow room, a far relay, a laptop out of headroom, somebody else's
 * upload — produced the same picture.
 *
 * So this reads the connection this browser actually has. Three numbers carry
 * most of the answer and they say different things:
 *
 *   Round trip is distance. It barely moves with load and it cannot be fixed by
 *   sending less, which is what makes it the number that says "you are on the
 *   wrong relay" rather than "your network is busy".
 *
 *   Loss is the network refusing to carry what was sent. It is what breaks a
 *   voice, and it is the one that gets worse the harder you push.
 *
 *   Rate is what is being pushed. On its own it says almost nothing; beside the
 *   other two it separates a quiet call from a starved one.
 *
 * The media server publishes a verdict of its own, and it is used as a floor
 * rather than as the answer. It sees this participant from the far side and
 * knows things this browser cannot — but it grades on its own scale, and the
 * numbers below are what somebody can act on.
 */

import { ConnectionQuality, type Room, RoomEvent } from "livekit-client";
import { useEffect, useRef, useState } from "react";

/** How good the connection is, in the three states a light can be. */
export type Grade = "good" | "fair" | "poor" | "lost";

export interface Reading {
	grade: Grade;
	/** Round trip to the relay, in milliseconds. */
	rttMs?: number;
	/** Of what this browser sent, the share the far end never received. */
	lossPercent?: number;
	/** What is being sent and received, in kilobits per second. */
	upKbps?: number;
	downKbps?: number;
	/** How unevenly packets are arriving, in milliseconds. */
	jitterMs?: number;
	/** Whether anything has been measured yet. */
	measured: boolean;
}

/**
 * How often to look.
 *
 * Two seconds. Every reading walks the whole stats report for every published
 * track, which is not free, and a number that moves faster than somebody can
 * read it is a number nobody reads. Rates are means across the gap for the same
 * reason: an instantaneous bitrate on a screen is a flicker.
 */
const EVERY_MS = 2000;

/**
 * Where the bands are.
 *
 * Round trip first, because it is the one somebody can do something about — a
 * relay on the wrong continent shows up here and nowhere else. A hundred and
 * fifty milliseconds is about where a conversation starts to feel like people
 * talking over each other; four hundred is where they give up and take turns.
 *
 * Loss matters at lower numbers than people expect. Two per cent is audible on
 * a voice; eight per cent is a call somebody is going to leave.
 */
const GOOD_RTT_MS = 150;
const FAIR_RTT_MS = 400;
const GOOD_LOSS = 2;
const FAIR_LOSS = 8;

/** What was true last time, so that rates and loss can be a change rather than a total. */
interface Previous {
	at: number;
	bytesSent: number;
	bytesReceived: number;
	packetsSent: number;
	packetsLost: number;
}

/**
 * Watch the connection this room is running on.
 *
 * Returns a reading that updates on its own. Safe to call with no room: before
 * one is connected there is nothing to measure and the reading says so, rather
 * than reporting a healthy zero — which is how a disconnected call comes to
 * show three green bars.
 */
export function useConnectionQuality(room: Room | undefined): Reading {
	const [reading, setReading] = useState<Reading>({ grade: "good", measured: false });
	const previous = useRef<Previous>();

	// The server's own verdict, kept apart from the numbers because it arrives
	// on an event rather than on the clock.
	const published = useRef<ConnectionQuality>(ConnectionQuality.Excellent);

	useEffect(() => {
		if (!room) {
			previous.current = undefined;
			setReading({ grade: "good", measured: false });
			return;
		}

		let live = true;

		const onQuality = (quality: ConnectionQuality, participant?: { isLocal?: boolean }) => {
			// Only this browser's own. Somebody else's bad connection is their
			// news, and putting it in this reading would tell the wrong person
			// to go and find a better network.
			if (participant && participant.isLocal === false) return;
			published.current = quality;
		};

		room.on(RoomEvent.ConnectionQualityChanged, onQuality as never);

		const look = async () => {
			const now = Date.now();
			const stats = await gather(room);

			if (!live) return;

			const was = previous.current;
			previous.current = { at: now, ...stats.totals };

			// The first pass has nothing to compare against, so it establishes
			// the baseline and says only what it can say without one.
			const seconds = was ? (now - was.at) / 1000 : 0;

			const upKbps =
				was && seconds > 0
					? Math.max(0, ((stats.totals.bytesSent - was.bytesSent) * 8) / seconds / 1000)
					: undefined;

			const downKbps =
				was && seconds > 0
					? Math.max(0, ((stats.totals.bytesReceived - was.bytesReceived) * 8) / seconds / 1000)
					: undefined;

			// Loss over the interval rather than since the call began. A call
			// that lost badly for ten seconds an hour ago is fine now, and a
			// lifetime average would go on reporting the ten seconds all evening.
			let lossPercent: number | undefined;
			if (was) {
				const sent = stats.totals.packetsSent - was.packetsSent;
				const lost = stats.totals.packetsLost - was.packetsLost;

				if (sent > 0) lossPercent = Math.max(0, Math.min(100, (lost / (sent + lost)) * 100));
			}

			setReading({
				grade: grade(published.current, stats.rttMs, lossPercent),
				rttMs: stats.rttMs,
				jitterMs: stats.jitterMs,
				lossPercent,
				upKbps,
				downKbps,
				measured: was !== undefined,
			});
		};

		void look();
		const timer = setInterval(() => void look(), EVERY_MS);

		return () => {
			live = false;
			clearInterval(timer);
			room.off(RoomEvent.ConnectionQualityChanged, onQuality as never);
		};
	}, [room]);

	return reading;
}

/** What the bands come out as, with the server's verdict as a floor. */
export function grade(
	published: ConnectionQuality,
	rttMs: number | undefined,
	lossPercent: number | undefined,
): Grade {
	if (published === ConnectionQuality.Lost) return "lost";

	let own: Grade = "good";

	if (rttMs !== undefined) {
		if (rttMs > FAIR_RTT_MS) own = "poor";
		else if (rttMs > GOOD_RTT_MS) own = "fair";
	}

	if (lossPercent !== undefined) {
		if (lossPercent > FAIR_LOSS) own = "poor";
		else if (lossPercent > GOOD_LOSS && own === "good") own = "fair";
	}

	// The server sees this participant from the other side and knows things this
	// browser cannot. Where it is less happy than the numbers here, believe it:
	// a reading that says everything is fine while the call is visibly not is
	// worse than no reading, because it sends somebody looking in the wrong
	// place.
	if (published === ConnectionQuality.Poor && own === "good") return "fair";

	return own;
}

interface Gathered {
	rttMs?: number;
	jitterMs?: number;
	totals: {
		bytesSent: number;
		bytesReceived: number;
		packetsSent: number;
		packetsLost: number;
	};
}

/**
 * Read every published and subscribed track's stats and add them up.
 *
 * Per track rather than per connection because that is what the SDK exposes;
 * the reports overlap, so the transport-level figures are taken once and the
 * per-stream ones are summed.
 */
async function gather(room: Room): Promise<Gathered> {
	const out: Gathered = {
		totals: { bytesSent: 0, bytesReceived: 0, packetsSent: 0, packetsLost: 0 },
	};

	const reports: RTCStatsReport[] = [];

	for (const publication of room.localParticipant.trackPublications.values()) {
		const report = await publication.track?.getRTCStatsReport?.();
		if (report) reports.push(report);
	}

	for (const participant of room.remoteParticipants.values()) {
		for (const publication of participant.trackPublications.values()) {
			const report = await publication.track?.getRTCStatsReport?.();
			if (report) reports.push(report);
		}
	}

	// Counted once each, because a track's report describes its whole peer
	// connection: two tracks on one connection would otherwise double every
	// byte, and the bitrate would read as twice what is being sent.
	const seen = new Set<string>();

	for (const report of reports) {
		report.forEach((entry: Record<string, unknown> & { type?: string; id?: string }) => {
			const id = String(entry.id ?? "");
			if (id && seen.has(id)) return;
			if (id) seen.add(id);

			switch (entry.type) {
				case "candidate-pair": {
					// The one in use. A connection collects several and reports
					// them all, and the ones that lost the race have stale or
					// absent timings.
					if (entry.state !== "succeeded" || entry.nominated !== true) return;

					const rtt = numeric(entry.currentRoundTripTime);
					if (rtt !== undefined) out.rttMs = Math.round(rtt * 1000);
					return;
				}

				case "outbound-rtp": {
					out.totals.bytesSent += numeric(entry.bytesSent) ?? 0;
					out.totals.packetsSent += numeric(entry.packetsSent) ?? 0;
					return;
				}

				case "remote-inbound-rtp": {
					// What the far end says it did not get. The near side cannot
					// know this — a packet that never arrived leaves no trace
					// here — which is why loss is read from the report that came
					// back rather than from the one written locally.
					out.totals.packetsLost += Math.max(0, numeric(entry.packetsLost) ?? 0);

					const jitter = numeric(entry.jitter);
					if (jitter !== undefined) out.jitterMs = Math.round(jitter * 1000);

					// Some browsers report a round trip here and nowhere else.
					if (out.rttMs === undefined) {
						const rtt = numeric(entry.roundTripTime);
						if (rtt !== undefined) out.rttMs = Math.round(rtt * 1000);
					}

					return;
				}

				case "inbound-rtp": {
					out.totals.bytesReceived += numeric(entry.bytesReceived) ?? 0;
					return;
				}
			}
		});
	}

	return out;
}

/** A stats field, where it is a number and not something else. */
function numeric(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
