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

import { describe, expect, it, vi } from "vitest";

import type { Room } from "livekit-client";

import {
	FALLBACK,
	SHARE_FRAME_RATES,
	SHARE_QUALITIES,
	type ShareFrameRate,
	type ShareQuality,
	offers,
	ratesFor,
	settingsForTest,
	share,
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
	/*
	 * Nothing publishes a second, smaller copy of the screen any more, and
	 * automatic is no longer the exception.
	 *
	 * Simulcast divides the allowance between two or three encodes of the same
	 * picture and lets the server hand somebody the small one. For a camera in
	 * a grid of faces that is the right trade. For a share it is the wrong one
	 * twice: the share is the only thing anybody is looking at, so a smaller
	 * version of it is nobody's mitigation, and the extra encodes are what make
	 * an encoder fall behind — the machinery for coping with a slow connection
	 * making the picture slow.
	 */
	it("publishes one encode at every setting, automatic included", () => {
		expect(settingsForTest(30, "auto").adapts).toBe(false);

		for (const quality of named) {
			for (const rate of ratesFor(quality)) {
				expect(settingsForTest(rate, quality).adapts).toBe(false);
			}
		}
	});

	/*
	 * What gives, where something must: frames, never the picture, at every
	 * setting.
	 *
	 * This used to turn on the rate — the picture held below thirty frames and
	 * given away above it, on the reasoning that somebody asking for a high
	 * rate was asking for the frames. That is right about a camera and wrong
	 * about a screen. What is on a shared screen is text, code and diagrams,
	 * and the two failures are not comparable: a late frame is late, and type
	 * that has been scaled away is gone, with nothing the person reading it can
	 * do about it.
	 */
	it("never gives away the picture, at any setting", () => {
		expect(settingsForTest(30, "auto").degradationPreference).toBe("maintain-resolution");

		for (const quality of named) {
			for (const rate of ratesFor(quality)) {
				expect(settingsForTest(rate, quality).degradationPreference).toBe("maintain-resolution");
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

/*
The small copy, and why it is worth a test of its own.

It was removed once, on an argument that reads as sound: that simulcast divides
the allowance between the layers, so a fallback is paid for out of the picture
everybody is looking at. The SDK does no such thing — the top layer keeps the
encoding it was handed — but the mistake cost a live call, and it cost it
silently. A share published as one layer looks completely correct from the
sending end. It is the person on the far side of a thin path who gets nothing,
and they have no way to tell that apart from the sharing being broken.

So both halves are held here: that the top layer still asks for everything, and
that something smaller goes with it.
*/
describe("the small copy that goes with a share", () => {
	/** A room that records what it was asked to publish and does nothing else. */
	function watching() {
		const asked: { capture?: unknown; publish?: unknown } = {};

		const room = {
			localParticipant: {
				setScreenShareEnabled: async (_on: boolean, capture: unknown, publish: unknown) => {
					asked.capture = capture;
					asked.publish = publish;

					return undefined;
				},
			},
		} as unknown as Room;

		return { room, asked };
	}

	it("goes beneath the share rather than instead of it", async () => {
		const { room, asked } = watching();

		await share(room, true, 120, "1080p");

		const publish = asked.publish as {
			simulcast: boolean;
			screenShareSimulcastLayers: { encoding: { maxBitrate: number } }[];
			screenShareEncoding: { maxBitrate: number };
		};

		expect(publish.simulcast).toBe(true);
		expect(publish.screenShareSimulcastLayers).toHaveLength(1);

		// The half that matters most: nothing was taken off the top to pay for
		// it. What somebody chose is still what somebody able to receive it gets.
		expect(publish.screenShareEncoding.maxBitrate).toBe(settingsForTest(120, "1080p").maxBitrate);
	});

	it("is sized for a path that cannot carry the share at all", () => {
		// The leg this was measured on carried two megabits a second and lost a
		// tenth of its packets. A fallback that does not fit through that is not
		// a fallback; the SDK's own default for a share is a quarter of the top
		// layer, which for an ordinary ask is several megabits.
		expect(FALLBACK.encoding.maxBitrate).toBeLessThan(1_000_000);

		for (const quality of SHARE_QUALITIES) {
			for (const rate of ratesFor(quality)) {
				expect(FALLBACK.encoding.maxBitrate * 5).toBeLessThan(
					settingsForTest(rate, quality).maxBitrate,
				);
			}
		}
	});

	it("stays large enough to read", () => {
		// The thing being rescued is legibility. At 360 lines ordinary type is
		// gone, and a picture nobody can read is not worth the bits.
		expect(FALLBACK.height).toBeGreaterThanOrEqual(540);
		expect(FALLBACK.encoding.maxFramerate).toBeLessThanOrEqual(15);
	});
});

/*
The capture request, and the two opposite ways it was wrong.

Both produced the same silence: every share ran at thirty frames a second
whatever the menu said, and nothing reported it. The first version wrote media
constraints into `resolution`, which takes three plain numbers, so the SDK's
`resolution.width > 0` gate dropped everything. The second moved them to `video`
and left `resolution` out — and createLocalScreenTracks fills an absent
resolution with ScreenSharePresets.h1080fps30, which is then written over the
`video` constraints. Omitting the field is how a browser is asked for thirty
frames on purpose.

So there are two things to hold, and neither alone is enough: the field must be
there, and what is in it must be numbers.
*/
describe("what the browser is actually asked to capture", () => {
	function captured(rate: ShareFrameRate, quality: ShareQuality) {
		let capture: unknown;

		const room = {
			localParticipant: {
				setScreenShareEnabled: async (_on: boolean, asked: unknown) => {
					capture = asked;

					return undefined;
				},
			},
		} as unknown as Room;

		return share(room, true, rate, quality).then(
			() =>
				capture as {
					resolution?: { width?: unknown; height?: unknown; frameRate?: unknown };
					video?: unknown;
				},
		);
	}

	it("names a resolution at all, because leaving it out means thirty", async () => {
		const asked = await captured(120, "1080p");

		// createLocalScreenTracks: `if (options.resolution === undefined &&
		// !isSafari17Based()) options.resolution = h1080fps30.resolution`.
		expect(asked.resolution).toBeDefined();
	});

	it("puts numbers there, because the SDK compares them against zero", async () => {
		const asked = await captured(120, "1080p");

		// `resolution.width > 0` is false for an object, and the whole block —
		// size and rate together — is skipped without a word.
		expect(typeof asked.resolution?.width).toBe("number");
		expect(typeof asked.resolution?.height).toBe("number");
		expect(typeof asked.resolution?.frameRate).toBe("number");
	});

	it("carries the chosen rate through to the request", async () => {
		expect((await captured(120, "1080p")).resolution?.frameRate).toBe(120);
		expect((await captured(240, "1080p")).resolution?.frameRate).toBe(240);
		expect((await captured(60, "auto")).resolution?.frameRate).toBe(60);
	});

	it("asks for the clamped rate, not the one that was remembered", async () => {
		// 240 chosen while 1080p was, then 4K picked. The capture must be asked
		// for sixty, which is what 4K carries, rather than for a rate the browser
		// answers by giving whatever it likes.
		expect((await captured(240, "4k")).resolution?.frameRate).toBe(60);
	});

	it("never asks for more pixels than the display has", async () => {
		// The SDK writes `width: { ideal }` for everything but Safari 17, and an
		// ideal larger than the screen is an upscale: the display is stretched
		// before encoding, and the person sharing pays for the extra pixels on
		// the upstream that has the least room. The menu's sizes are ceilings, so
		// this is what they already meant.
		vi.stubGlobal("screen", { width: 1280, height: 720 });
		vi.stubGlobal("devicePixelRatio", 1);

		try {
			const asked = await captured(60, "4k");

			expect(asked.resolution?.width).toBe(1280);
			expect(asked.resolution?.height).toBe(720);

			// And the rate is untouched by the clamp: fewer pixels is not fewer
			// frames.
			expect(asked.resolution?.frameRate).toBe(60);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("asks for what was chosen when the display will not say", async () => {
		// jsdom reports a zero-sized screen, and so does anything else that has
		// no display. Clamping to nothing would be a share of no pixels.
		vi.stubGlobal("screen", { width: 0, height: 0 });

		try {
			expect((await captured(60, "1080p")).resolution?.width).toBe(1920);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
