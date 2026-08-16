/**
 * What these guard is a combination that looks fine and fails slowly.
 *
 * A screen share does not fail loudly when it is asked for more than the machine
 * can do. The encoder falls behind, and the picture stutters and drifts further
 * behind the longer it runs, and nothing anywhere reports an error. So the
 * pairings that cannot be delivered must not be offered, the ones that are
 * offered must be sent with settings that can carry them, and a rate remembered
 * from a larger allowance must not survive being applied to a smaller one.
 *
 * The other half is the promise the automatic setting makes and the named ones
 * do not. Somebody who picked 4K picked it: being quietly given 1080p is the
 * complaint rather than the mitigation, and only automatic is allowed to make
 * that trade.
 */

import { describe, expect, it } from "vitest";

import {
	SHARE_FRAME_RATES,
	SHARE_QUALITIES,
	type ShareFrameRate,
	type ShareQuality,
	offers,
	ratesFor,
	settingsForTest,
} from "./room";

const named = SHARE_QUALITIES.filter((one) => one !== "auto") as Exclude<ShareQuality, "auto">[];

describe("what is offered", () => {
	it("offers every rate a size can carry, slow ones included", () => {
		// A slow rate is always available: a page of code at 4K wants fifteen
		// frames and the sharpest picture, and refusing that refuses the better
		// answer.
		for (const quality of named) {
			expect(ratesFor(quality)).toContain(15);
			expect(ratesFor(quality)).toContain(30);
		}
	});

	it("stops each size where an encoder would stop keeping up", () => {
		expect(ratesFor("1080p")).toEqual([15, 30, 60, 120, 240]);
		expect(ratesFor("1440p")).toEqual([15, 30, 60, 120]);
		expect(ratesFor("4k")).toEqual([15, 30, 60]);

		expect(offers("4k", 120)).toBe(false);
		expect(offers("1440p", 240)).toBe(false);
	});

	// The one that would be silent. A rate chosen at 1080p and remembered, then
	// applied to 4K, must not reach an encoder that cannot do it.
	it("clamps a rate carried over from a size that allowed it", () => {
		expect(settingsForTest(240, "4k").frameRate).toBe(60);
		expect(settingsForTest(240, "1440p").frameRate).toBe(120);
		expect(settingsForTest(240, "1080p").frameRate).toBe(240);
	});
});

describe("what is sent", () => {
	it("has a size, a rate and a bitrate for every pairing offered", () => {
		for (const quality of named) {
			for (const rate of ratesFor(quality)) {
				const got = settingsForTest(rate, quality);

				expect(got.width).toBeGreaterThan(0);
				expect(got.height).toBeGreaterThan(0);
				expect(got.maxBitrate).toBeGreaterThan(0);
				expect(got.frameRate).toBe(rate);
			}
		}
	});

	// More pixels or more frames at the same ceiling is not more detail, it is
	// the same bitrate spread thinner — which is how a 4K option comes to look
	// worse than the 1080p one it replaced.
	it("raises the bitrate with both the pixels and the frames", () => {
		expect(settingsForTest(30, "4k").maxBitrate).toBeGreaterThan(
			settingsForTest(30, "1080p").maxBitrate,
		);

		expect(settingsForTest(120, "1080p").maxBitrate).toBeGreaterThan(
			settingsForTest(30, "1080p").maxBitrate,
		);
	});

	// Software encoding is affordable for a still 1080p picture and for nothing
	// else. Above either bound the failure is not a softer picture but an
	// encoder falling behind.
	it("only asks software encoding for a still 1080p picture", () => {
		expect(settingsForTest(15, "1080p").videoCodec).toBe("vp8");
		expect(settingsForTest(30, "1080p").videoCodec).toBe("vp8");

		expect(settingsForTest(60, "1080p").videoCodec).toBe("h264");
		expect(settingsForTest(30, "1440p").videoCodec).toBe("h264");
		expect(settingsForTest(15, "4k").videoCodec).toBe("h264");
		expect(settingsForTest(60, "4k").videoCodec).toBe("h264");
	});

	it("never publishes a share with an SVC codec", () => {
		// The SDK pins an SVC share to one spatial layer and overwrites the
		// content hint, so VP9 here would silently discard the reason the
		// sharper settings exist.
		for (const quality of SHARE_QUALITIES) {
			for (const rate of SHARE_FRAME_RATES) {
				expect(settingsForTest(rate as ShareFrameRate, quality)).not.toHaveProperty(
					"videoCodec",
					"vp9",
				);
			}
		}
	});
});

describe("automatic", () => {
	it("is the only setting that gives ground", () => {
		expect(settingsForTest(30, "auto").adapts).toBe(true);

		for (const quality of named) {
			for (const rate of ratesFor(quality)) {
				expect(settingsForTest(rate, quality).adapts).toBe(false);
			}
		}
	});

	// Somebody who picked a size picked it. What gives, where something must, is
	// the frame rate — never the picture they asked for.
	it("never lets a chosen size be quietly reduced", () => {
		for (const quality of named) {
			for (const rate of ratesFor(quality)) {
				expect(settingsForTest(rate, quality).degradationPreference).toBe(
					"maintain-resolution",
				);
			}
		}
	});
});
