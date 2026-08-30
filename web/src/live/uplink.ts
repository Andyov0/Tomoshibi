import type { LocalTrackPublication, LocalVideoTrack } from "livekit-client";

/**
 * What a share is allowed to send, decided from what is actually getting
 * through rather than from what the picture is worth.
 *
 * The bitrate for a share is worked out from its size and rate: so many bits
 * per pixel per frame, which says what that picture deserves and nothing about
 * what the line can carry. On a good connection that is right. On a mainland
 * Chinese home line it is a number nobody can send — 1440p at 120 frames comes
 * out at 22 Mb/s, and the upload on those connections is a fraction of it.
 *
 * What that produces is not a clean failure. The encoder makes the frames, the
 * network cannot take them, and the result is the share arriving in lurches
 * with a frame rate that never climbs. It reads as the software being bad at
 * its job.
 *
 * ## Why this follows rather than probes
 *
 * The obvious design is to measure the upload once before sharing and pick a
 * number. It does not work here, for a reason specific to the connections this
 * has to run on: the carriers shape *sustained* use. A burst gets through at
 * full speed and a stream that holds the line for thirty seconds is throttled,
 * so a probe measures the one number that is not the answer, and measures it
 * accurately.
 *
 * It also costs what it is trying to save — a probe is bandwidth spent before
 * anybody sees anything — and delays the moment the share appears.
 *
 * So nothing is probed. The browser is already estimating this continuously,
 * because congestion control is how WebRTC works at all, and it will say what
 * is limiting the picture: `qualityLimitationReason` is "bandwidth" when the
 * line is the constraint and "cpu" when the encoder is. Reading that costs one
 * `getStats` call every few seconds, and it notices carrier shaping at the
 * moment it starts, which is the thing a probe cannot do at all.
 *
 * ## What it does
 *
 * Down quickly, up slowly. A line that has just started dropping frames is a
 * line to get off immediately; a line that has been clean for a while may only
 * be clean because the ceiling is low. Halving on trouble and adding an eighth
 * on quiet is the ordinary shape for this, and the asymmetry is the point:
 * being wrong downwards costs sharpness and being wrong upwards costs the call.
 *
 * The floor is a picture still worth looking at. Below about a megabit a shared
 * screen is unreadable, and at that point the honest thing is to stop lowering
 * it and let the person choose a smaller size themselves.
 */

/** How often to look. */
const EVERY_MS = 4000;

/**
 * How long a line has to behave before it is trusted with more.
 *
 * Three readings — twelve seconds — because carrier shaping does not arrive
 * with the first packet. Raising after one quiet reading walks straight back
 * into the ceiling it just came down from, repeatedly, which is worse than
 * staying low: each attempt is a fresh few seconds of loss.
 */
const QUIET_ROUNDS = 3;

/** Never below this, because a share nobody can read is not a saving. */
const FLOOR = 1_200_000;

/** How much of the ceiling to give back at a time. */
const EASE_UP = 1.125;
const BACK_OFF = 0.5;

/**
 * Where this line settled last time, so the next share does not start by
 * finding out again.
 *
 * The ceiling a share opens at is worked out from its size and rate and knows
 * nothing about the connection — 1440p at 120 frames asks for 22 Mb/s, and on a
 * line that can carry six the follower needs five halvings to get there. That
 * is twenty seconds of loss at the start of every single share, every time, for
 * an answer the line already gave.
 *
 * Kept per browser rather than per room, because it is a fact about the line
 * and not about the meeting. A starting point rather than a cap: the follower
 * eases back up as usual, so a line that has improved is found out again within
 * the minute, and one that has got worse costs the ordinary back-off.
 */
const SETTLED_KEY = "meet-live.uplink";

/** What the line took last time, or nothing if it has never been measured. */
export function settled(): number {
	try {
		const said = Number(localStorage.getItem(SETTLED_KEY));
		return Number.isFinite(said) && said > 0 ? said : 0;
	} catch {
		return 0;
	}
}

function remember(bits: number) {
	try {
		localStorage.setItem(SETTLED_KEY, String(Math.round(bits)));
	} catch {
		// A browser refusing storage costs the next share its head start and
		// nothing else.
	}
}

export interface Uplink {
	/** Stop following. */
	stop: () => void;
	/** What it settled on, for anything that wants to say so. */
	at: () => number;
}

/**
 * Follow a share's real ceiling for as long as it is being shared.
 *
 * `wanted` is what the size and rate are worth, and is never exceeded: this
 * lowers a ceiling and gives it back, and does not invent bandwidth somebody
 * did not ask to use.
 */
export function follow(publication: LocalTrackPublication, wanted: number, from = 0): Uplink {
	const track = publication.track as LocalVideoTrack | undefined;

	// Where the line was last time, never above what this picture is worth.
	// Somebody sharing a small window after a big one should not open at the
	// big one's number.
	let ceiling = from > 0 ? Math.min(wanted, from) : wanted;
	let quiet = 0;
	let live = true;

	// The last reading, so the interesting number is the difference. Frames sent
	// and NACKs are both counters that only go up.
	let sent = 0;
	let nacked = 0;

	const apply = async (bitrate: number) => {
		const sender = track?.sender;
		if (!sender) return;

		try {
			const parameters = sender.getParameters();
			if (!parameters.encodings?.length) return;

			for (const encoding of parameters.encodings) encoding.maxBitrate = bitrate;

			await sender.setParameters(parameters);
		} catch {
			// A sender that has gone away, or a browser that will not take the
			// change. Either way the share goes on at whatever it was, which is
			// the state this exists to improve rather than to depend on.
		}
	};

	const look = async () => {
		if (!live || !track) return;

		let stats: Awaited<ReturnType<LocalVideoTrack["getSenderStats"]>>;
		try {
			stats = await track.getSenderStats();
		} catch {
			return;
		}

		const one = stats[0];
		if (!one) return;

		// The browser's own verdict, which is the whole reason this needs no
		// probe of its own. "bandwidth" is the line; "cpu" is the encoder, and
		// lowering the bitrate for a busy encoder buys nothing — what that wants
		// is fewer pixels or fewer frames, which is the person's choice to make.
		const starved = one.qualityLimitationReason === "bandwidth";

		// And a second opinion, because the reason is not reported everywhere.
		// Retransmission requests rising while frames are not is the same story
		// told by the far end.
		const framesNow = one.framesSent ?? 0;
		const nacksNow = one.nackCount ?? 0;

		const frames = framesNow - sent;
		const nacks = nacksNow - nacked;

		sent = framesNow;
		nacked = nacksNow;

		// Ten in four seconds is not a blip. A clean line produces a handful.
		const struggling = starved || (nacks > 10 && frames < EVERY_MS / 40);

		if (struggling) {
			quiet = 0;

			const lower = Math.max(FLOOR, Math.round(ceiling * BACK_OFF));
			if (lower < ceiling) {
				ceiling = lower;
				await apply(ceiling);
				remember(ceiling);
			}

			return;
		}

		quiet += 1;
		if (quiet < QUIET_ROUNDS || ceiling >= wanted) return;

		quiet = 0;
		ceiling = Math.min(wanted, Math.round(ceiling * EASE_UP));
		await apply(ceiling);
		remember(ceiling);
	};

	// Applied straight away where there is something to apply, because the point
	// of starting from last time is not to spend the first four seconds at a
	// number the line has already refused.
	if (ceiling < wanted) void apply(ceiling);

	const timer = setInterval(() => void look(), EVERY_MS);

	return {
		stop: () => {
			live = false;
			clearInterval(timer);
		},
		at: () => ceiling,
	};
}
