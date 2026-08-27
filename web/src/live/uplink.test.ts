import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { follow } from "./uplink";

/*
 * What a share is allowed to send, against what the line will take.
 *
 * The bitrate a share is published with comes from its size and rate — so many
 * bits per pixel per frame — which says what the picture is worth and nothing
 * about what can be sent. 1440p at 120 frames comes to 22 Mb/s, and a mainland
 * Chinese home line has a fraction of that upload. The encoder makes the
 * frames, the line cannot take them, and it arrives as a share that lurches
 * with a frame rate that never climbs.
 *
 * Nothing here probes. The carriers on those lines shape sustained use rather
 * than bursts, so a measurement taken before the share starts returns the one
 * number that is not the answer — and the browser is already estimating this
 * continuously anyway, and will say whether the picture is limited by the line
 * or by the processor.
 *
 * The asymmetry is the whole design: down at once, up after a while. Being
 * wrong downwards costs sharpness; being wrong upwards costs the call.
 */

const WANTED = 8_000_000;

let parameters: RTCRtpSendParameters;
let stats: Array<Record<string, unknown>>;
let applied: number[];

function publication() {
	parameters = { encodings: [{}], transactionId: "", codecs: [], headerExtensions: [], rtcp: {} } as unknown as RTCRtpSendParameters;
	applied = [];

	const sender = {
		getParameters: () => parameters,
		setParameters: (next: RTCRtpSendParameters) => {
			parameters = next;
			applied.push(next.encodings[0]?.maxBitrate ?? 0);
			return Promise.resolve();
		},
	};

	return {
		track: {
			sender,
			getSenderStats: () => Promise.resolve(stats),
		},
	} as never;
}

// Four seconds per round, which is the interval the watcher runs on.
async function rounds(n: number) {
	for (let i = 0; i < n; i++) {
		await vi.advanceTimersByTimeAsync(4000);
	}
}

beforeEach(() => {
	vi.useFakeTimers();
	stats = [{ qualityLimitationReason: "none", framesSent: 0, nackCount: 0 }];
});

afterEach(() => vi.useRealTimers());

describe("a line that cannot take what was asked for", () => {
	it("halves the ceiling as soon as the browser says bandwidth", async () => {
		const link = follow(publication(), WANTED);

		stats = [{ qualityLimitationReason: "bandwidth", framesSent: 100, nackCount: 0 }];
		await rounds(1);

		expect(link.at()).toBe(WANTED / 2);
		expect(applied).toEqual([WANTED / 2]);

		link.stop();
	});

	it("keeps halving while it goes on", async () => {
		const link = follow(publication(), WANTED);

		stats = [{ qualityLimitationReason: "bandwidth", framesSent: 100, nackCount: 0 }];
		await rounds(2);

		expect(link.at()).toBe(WANTED / 4);

		link.stop();
	});

	// A share nobody can read is not a saving, and at that point the honest
	// thing is to let the person choose a smaller size themselves.
	it("stops at a picture still worth looking at", async () => {
		const link = follow(publication(), WANTED);

		stats = [{ qualityLimitationReason: "bandwidth", framesSent: 100, nackCount: 0 }];
		await rounds(20);

		expect(link.at()).toBe(1_200_000);

		link.stop();
	});
});

describe("a line that is behaving", () => {
	it("does not raise a ceiling that was never lowered", async () => {
		const link = follow(publication(), WANTED);

		await rounds(10);

		expect(link.at()).toBe(WANTED);
		expect(applied).toEqual([]);

		link.stop();
	});

	// Carrier shaping does not arrive with the first packet, so one quiet
	// reading is not evidence. Raising on it walks straight back into the
	// ceiling it just came down from, and each attempt is a fresh few seconds
	// of loss.
	it("waits before giving any back", async () => {
		const link = follow(publication(), WANTED);

		stats = [{ qualityLimitationReason: "bandwidth", framesSent: 100, nackCount: 0 }];
		await rounds(1);
		const dropped = link.at();

		stats = [{ qualityLimitationReason: "none", framesSent: 200, nackCount: 0 }];
		await rounds(2);
		expect(link.at()).toBe(dropped);

		await rounds(1);
		expect(link.at()).toBeGreaterThan(dropped);

		link.stop();
	});

	it("never gives back more than was asked for", async () => {
		const link = follow(publication(), WANTED);

		stats = [{ qualityLimitationReason: "bandwidth", framesSent: 100, nackCount: 0 }];
		await rounds(1);

		stats = [{ qualityLimitationReason: "none", framesSent: 200, nackCount: 0 }];
		await rounds(60);

		expect(link.at()).toBe(WANTED);

		link.stop();
	});
});

/*
 * The distinction that decides whether this does anything useful at all.
 *
 * A busy encoder and a full line look the same from the outside — frames go
 * missing either way — and the remedies are opposite. Lowering the bitrate for
 * an encoder that cannot keep up buys nothing: it is already producing fewer
 * frames than it was asked for, and what it needs is fewer pixels or fewer
 * frames, which is the person's choice rather than this one's.
 */
describe("a processor that cannot keep up", () => {
	it("is left alone", async () => {
		const link = follow(publication(), WANTED);

		stats = [{ qualityLimitationReason: "cpu", framesSent: 10, nackCount: 0 }];
		await rounds(5);

		expect(link.at()).toBe(WANTED);
		expect(applied).toEqual([]);

		link.stop();
	});
});

describe("a browser that does not say why", () => {
	// Not every browser reports qualityLimitationReason. Retransmission
	// requests climbing while frames are not is the same story told by the far
	// end, and is what this falls back to.
	it("reads retransmissions instead", async () => {
		const link = follow(publication(), WANTED);

		stats = [{ framesSent: 5, nackCount: 40 }];
		await rounds(1);

		expect(link.at()).toBe(WANTED / 2);

		link.stop();
	});

	it("does not mistake a busy share for a struggling one", async () => {
		const link = follow(publication(), WANTED);

		// Plenty of frames and a handful of retransmissions, which is what an
		// ordinary connection looks like.
		stats = [{ framesSent: 480, nackCount: 3 }];
		await rounds(5);

		expect(link.at()).toBe(WANTED);

		link.stop();
	});
});

describe("stopping", () => {
	it("stops looking", async () => {
		const link = follow(publication(), WANTED);
		link.stop();

		stats = [{ qualityLimitationReason: "bandwidth", framesSent: 100, nackCount: 0 }];
		await rounds(5);

		expect(link.at()).toBe(WANTED);
		expect(applied).toEqual([]);
	});
});
