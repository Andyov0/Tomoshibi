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
	BENEATH,
	MIDDLE,
	SMALL,
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
		expect(publish.screenShareSimulcastLayers).toEqual(BENEATH);

		// The half that matters most: nothing was taken off the top to pay for
		// them. What somebody chose is still what somebody able to receive it
		// gets.
		expect(publish.screenShareEncoding.maxBitrate).toBe(settingsForTest(120, "1080p").maxBitrate);
	});

	it("keeps the bottom rung under what any real stage will ask for", () => {
		// The server picks by height: `requestedSize = height * 0.9`, then the
		// smallest layer at least that tall. A rung at 540 lines is therefore
		// chosen for an element between about 400 and 640 device pixels — a
		// maximised 1366x768 laptop, a phone held sideways — and those people
		// were handed the starved-path picture while having the bandwidth and
		// the pixels for the real one.
		//
		// 400 device pixels is below any stage this draws, so the bottom rung is
		// reached by congestion and not by a tile.
		expect(SMALL.height / 0.9).toBeLessThanOrEqual(400);
	});

	it("keeps the bottom rung inside a path that carries nothing else", () => {
		// The leg this was measured on carried two megabits a second and lost a
		// tenth of its packets. A rung that does not fit through that is not a
		// fallback; the SDK's own default for a share is a quarter of the top
		// layer, which for an ordinary ask is several megabits.
		expect(SMALL.encoding.maxBitrate).toBeLessThan(1_000_000);

		for (const quality of SHARE_QUALITIES) {
			for (const rate of ratesFor(quality)) {
				expect(SMALL.encoding.maxBitrate * 5).toBeLessThan(
					settingsForTest(rate, quality).maxBitrate,
				);
			}
		}
	});

	it("climbs, so a small window is not sent the starved picture", () => {
		// The middle rung is what an element too small for the top layer should
		// get. It has to be bigger in every dimension that decides a selection,
		// or it is not a rung.
		expect(MIDDLE.height).toBeGreaterThan(SMALL.height);
		expect(MIDDLE.encoding.maxBitrate).toBeGreaterThan(SMALL.encoding.maxBitrate);
		expect(MIDDLE.encoding.maxFramerate ?? 0).toBeGreaterThan(SMALL.encoding.maxFramerate ?? 0);

		// And smallest first: the SDK sorts presets ascending and hands the
		// encodings back in that order, which is the order retune walks.
		expect(BENEATH).toEqual([SMALL, MIDDLE]);
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

	it("asks for the size that was chosen, whatever screen the window is on", async () => {
		// This was clamped to `screen` for a while, so that `ideal` could not
		// become an upscale. `screen` describes the display the browser window is
		// on and not the surface the picker returns, so somebody with a laptop
		// and a 4K monitor who chose 4K and shared the monitor was handed 1080p
		// of it. Losing a picture somebody asked for is the worse trade; the
		// ceiling is corrected afterwards instead, against what actually arrived.
		vi.stubGlobal("screen", { width: 1280, height: 720 });
		vi.stubGlobal("devicePixelRatio", 1);

		try {
			const asked = await captured(60, "4k");

			expect(asked.resolution?.width).toBe(3840);
			expect(asked.resolution?.height).toBe(2160);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

/*
The ceiling, once the picture has arrived.

What a share is worth is computed from the size that was chosen, and the size
that was chosen is a request: a window is smaller than a screen, and
`width: { ideal }` is a target the browser may miss. A capture that came back
small was being sent with a ceiling worked out for one that did not, which is
upload reserved for nothing — and upload is the scarce thing on the connections
this has to work on.

Downward only. Raising it would be this file arguing with the setting somebody
chose.
*/
describe("the ceiling after the capture", () => {
	function shared(settings: { width?: number; height?: number }) {
		const encodings = [{ maxBitrate: 1 }, { maxBitrate: 999_999_999 }];

		const publication = {
			videoTrack: {
				sender: {
					getParameters: () => ({ encodings }),
					setParameters: async () => undefined,
				},
				mediaStreamTrack: { getSettings: () => settings },
			},
		};

		const room = {
			localParticipant: {
				setScreenShareEnabled: async () => publication,
			},
		} as unknown as Room;

		return { room, encodings };
	}

	it("comes down to what a smaller capture is worth", async () => {
		// 4K was chosen; a 1080p window came back.
		const { room, encodings } = shared({ width: 1920, height: 1080 });

		await share(room, true, 30, "4k");

		const top = encodings[1];
		if (!top) throw new Error("no top encoding");

		expect(top.maxBitrate).toBe(settingsForTest(30, "1080p").maxBitrate);
		expect(top.maxBitrate).toBeLessThan(settingsForTest(30, "4k").maxBitrate);
	});

	it("leaves the rungs beneath it alone", async () => {
		const { room, encodings } = shared({ width: 1920, height: 1080 });

		await share(room, true, 30, "4k");

		// The small ones follow the capture through scaleResolutionDownBy, which
		// the SDK worked out from the same picture. Rewriting them here would be
		// two answers to one question.
		expect(encodings[0]?.maxBitrate).toBe(1);
	});

	it("does not move when the capture is the size that was asked for", async () => {
		const { room, encodings } = shared({ width: 1920, height: 1080 });

		await share(room, true, 30, "1080p");

		expect(encodings[1]?.maxBitrate).toBe(999_999_999);
	});

	it("does not move when the capture will not say", async () => {
		const { room, encodings } = shared({});

		await share(room, true, 30, "4k");

		expect(encodings[1]?.maxBitrate).toBe(999_999_999);
	});
});
