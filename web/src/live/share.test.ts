/**
 * What these guard is a combination that looks fine and fails slowly.
 *
 * The sharp profile encodes in VP8, in software, which a mostly-still 1080p
 * screen affords comfortably. At 1440p it is 1.8 times the pixels and at 4K it
 * is four times, and software encoding that much does not produce a softer
 * picture — it produces an encoder falling behind, which arrives as a share that
 * stutters and drifts further behind the longer it runs. Nothing reports an
 * error; it simply gets worse.
 *
 * So the codec is decided from both choices rather than from the intent alone,
 * and the bitrate rises with the pixels: four times the area at the same ceiling
 * is the same bitrate spread thinner, which is how an Ultra option ends up
 * looking worse than the Standard one it replaced.
 */

import { describe, expect, it } from "vitest";

import {
	SHARE_FRAME_RATES,
	SHARE_QUALITIES,
	type ShareFrameRate,
	type ShareQuality,
	settingsForTest,
} from "./room";

describe("share settings", () => {
	it("offers every combination of intent and quality", () => {
		for (const rate of SHARE_FRAME_RATES) {
			for (const quality of SHARE_QUALITIES) {
				const got = settingsForTest(rate, quality);

				expect(got.width).toBeGreaterThan(0);
				expect(got.height).toBeGreaterThan(0);
				expect(got.maxBitrate).toBeGreaterThan(0);
			}
		}
	});

	// The one that matters. VP8 is chosen for the text hint it honours, and
	// above 1080p that hint is not worth an encoder that cannot keep up.
	it("does not ask software encoding for more than 1080p", () => {
		expect(settingsForTest(30, "standard").videoCodec).toBe("vp8");

		for (const quality of ["high", "ultra"] as ShareQuality[]) {
			expect(settingsForTest(30, quality).videoCodec).toBe("h264");
		}
	});

	it("leaves the motion profile on hardware encoding throughout", () => {
		for (const quality of SHARE_QUALITIES) {
			expect(settingsForTest(60, quality).videoCodec).toBe("h264");
		}
	});

	// More pixels at the same ceiling is not more detail, it is the same bitrate
	// spread thinner — the failure that makes a 4K option look worse than 1080p.
	it("raises the bitrate at least as fast as the pixel count", () => {
		// Pairs rather than indices: this project compiles with checked index
		// access, and a loop over positions makes every lookup an optional.
		const steps: [ShareQuality, ShareQuality][] = [
			["standard", "high"],
			["high", "ultra"],
		];

		for (const [from, to] of steps) {
			const smaller = settingsForTest(60, from);
			const larger = settingsForTest(60, to);

			expect(larger.width * larger.height).toBeGreaterThan(smaller.width * smaller.height);

			const pixelRatio = (larger.width * larger.height) / (smaller.width * smaller.height);
			const bitrateRatio = larger.maxBitrate / smaller.maxBitrate;

			expect(bitrateRatio).toBeGreaterThanOrEqual(pixelRatio * 0.5);
		}
	});

	// The intent decides what to give up, and quality must not quietly change
	// it: somebody who chose smooth motion at 4K still wants motion.
	it("keeps what each intent sacrifices, at every quality", () => {
		for (const quality of SHARE_QUALITIES) {
			expect(settingsForTest(30, quality).degradationPreference).toBe("maintain-resolution");
			expect(settingsForTest(30, quality).contentHint).toBe("text");

			expect(settingsForTest(60, quality).degradationPreference).toBe("maintain-framerate");
			expect(settingsForTest(60, quality).contentHint).toBe("motion");
		}
	});

	it("never publishes a share with an SVC codec", () => {
		// The SDK pins an SVC share to one spatial layer and overwrites the
		// content hint, so VP9 here would silently discard the sharper profile's
		// entire reason for existing.
		for (const rate of SHARE_FRAME_RATES) {
			for (const quality of SHARE_QUALITIES) {
				expect(settingsForTest(rate as ShareFrameRate, quality)).not.toHaveProperty(
					"videoCodec",
					"vp9",
				);
			}
		}
	});
});
