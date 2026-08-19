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

	/*
	 * Never software, at any size or rate.
	 *
	 * A still 1080p picture used to take VP8, which draws text a little more
	 * crisply — it has no chroma subsampling to soften coloured letters. What
	 * that cost was hidden by which side pays it: VP8 is software essentially
	 * everywhere, to encode and to decode, and a share is the one track in a call
	 * that everybody is looking at. One person's processor bought the sharpness
	 * and everybody else's paid for it, phones included.
	 */
	it("never asks for a codec the machine has to do in software", () => {
		for (const quality of SHARE_QUALITIES) {
			for (const rate of SHARE_FRAME_RATES) {
				expect(settingsForTest(rate as ShareFrameRate, quality).videoCodec).toBe("h264");
			}
		}
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

	/*
	 * What gives, where something must, depends on what was asked for — and
	 * getting it the same for both is how a share came to stutter.
	 *
	 * Holding the resolution and dropping frames was the rule for every chosen
	 * size. That is right about a still picture, where every pixel matters and a
	 * dropped frame costs nothing, and wrong about a moving one, where the frames
	 * are the entire reason the rate was raised: it turned a busy encoder or a
	 * moment of congestion into a stutter, which is both the first thing anybody
	 * notices and the thing they can do least about.
	 */
	it("protects the pixels of a still picture and the frames of a moving one", () => {
		for (const quality of named) {
			for (const rate of ratesFor(quality)) {
				const wanted = rate <= 30 ? "maintain-resolution" : "balanced";

				expect(settingsForTest(rate, quality).degradationPreference).toBe(wanted);
			}
		}
	});

	/*
	 * A rate costs far less than a size, and treating them the same is what put
	 * the high settings out of reach.
	 *
	 * Multiplying by frames a second assumes every frame costs what the first one
	 * did — true of a camera pointed at a room, emphatically false of a screen,
	 * where one frame differs from the last by a moved cursor. Linear, 1440p at a
	 * hundred and twenty asked for forty-four megabits a second; the estimator
	 * finds out, clamps, and the encoder answers by dropping frames, which arrives
	 * as a stutter while the throughput reading looks healthy.
	 */
	it("charges far less for frames than for pixels", () => {
		const still = settingsForTest(30, "1440p").maxBitrate;
		const moving = settingsForTest(120, "1440p").maxBitrate;

		// Four times the frames, nothing like four times the bitrate.
		expect(moving).toBeGreaterThan(still);
		expect(moving).toBeLessThan(still * 2.5);

		// And a bigger picture still costs more than a faster one, which is the
		// ordering that was inverted before: 4K at sixty asked for less than 1080p
		// at two hundred and forty.
		expect(settingsForTest(60, "4k").maxBitrate).toBeGreaterThan(
			settingsForTest(240, "1080p").maxBitrate,
		);
	});
});
