import type { Room } from "livekit-client";
import { describe, expect, it, vi } from "vitest";
import { SHARE_FRAME_RATES, type ShareFrameRate,
	type ShareQuality, share } from "./room";

/*
 * What these guard is a control that lied.
 *
 * The interface offered thirty frames a second or sixty, and the browser was
 * duly asked to capture whichever was chosen — but the encoder had a ceiling of
 * its own, fixed at thirty, and half of every sixty-frame capture was thrown
 * away before it left the machine. Choosing the second option cost twice the
 * capture work to send precisely what the first one sent, and nothing anywhere
 * said so.
 *
 * A fault of that shape cannot be seen from either end. The capture is genuinely
 * running at sixty, the picture genuinely arrives, and only a number buried in a
 * publication says the two do not meet. So the meeting point is what is asserted
 * here, rather than any of the things that looked fine while it was broken.
 */

/** A stub of the one call `share` makes, which reports how it was made. */
function watchShare() {
	const setScreenShareEnabled = vi.fn().mockResolvedValue(undefined);
	const room = { localParticipant: { setScreenShareEnabled } } as unknown as Room;

	return {
		room,
		/** The capture options and the publish options, as they were passed. */
		/**
		 * A size is always given, because automatic chooses the rate itself.
		 *
		 * These tests are about a rate reaching the encoder, and under the
		 * automatic setting there is nothing to reach it with — it picks 1080p
		 * at thirty and adapts. Passing a size is what makes the question
		 * askable.
		 */
		async started(frameRate: ShareFrameRate, quality: ShareQuality = "1080p") {
			setScreenShareEnabled.mockClear();
			await share(room, true, frameRate, quality);

			const call = setScreenShareEnabled.mock.calls[0];
			if (!call) throw new Error("share did not ask for a screen");

			const [, capture, publish] = call;
			return { capture, publish };
		},
	};
}

describe("share", () => {
	it.each(SHARE_FRAME_RATES)("carries %i frames all the way to the encoder", async (rate) => {
		const { started } = watchShare();
		// 1080p, which is the size that can carry every rate offered.
		const { capture, publish } = await started(rate);

		// Both halves, because either one alone is a number with no effect: a
		// capture nobody encodes, or an encoder with nothing to encode.
		expect(capture.resolution.frameRate).toBe(rate);
		expect(publish.screenShareEncoding.maxFramerate).toBe(rate);
	});

	it("shares the whole screen at either rate", async () => {
		const { started } = watchShare();

		for (const rate of SHARE_FRAME_RATES) {
			const { capture } = await started(rate);
			expect(capture.resolution.width).toBe(1920);
			expect(capture.resolution.height).toBe(1080);
		}
	});

	/*
	 * The hint is the whole of the sharper profile, and an SVC codec would have
	 * the SDK overwrite it on the way out. Asserting the pair together is what
	 * keeps somebody from later restoring the codec the camera uses and quietly
	 * undoing the hint along with it.
	 */
	it("asks for text with a codec that will pass the request on", async () => {
		const { started } = watchShare();
		const { capture, publish } = await started(30);

		expect(capture.contentHint).toBe("text");
		expect(["vp8", "h264"]).toContain(publish.videoCodec);
		expect(publish.degradationPreference).toBe("maintain-resolution");
	});

	it("asks for motion when the picture moves, and keeps the size that was chosen", async () => {
		const { started } = watchShare();
		const { capture, publish } = await started(60);

		expect(capture.contentHint).toBe("motion");
		expect(["vp8", "h264"]).toContain(publish.videoCodec);

		// Above thirty frames the frames are the point, so a shortfall gives away
		// a little size rather than gutting the rate. Holding the resolution here
		// turned every busy moment into a stutter — the one thing somebody
		// watching a share notices first and can do least about.
		expect(publish.degradationPreference).toBe("balanced");
	});

	it("gives the busier picture the larger ceiling", async () => {
		const { started } = watchShare();
		const gentle = await started(30);
		const busy = await started(120);

		expect(busy.publish.screenShareEncoding.maxBitrate).toBeGreaterThan(
			gentle.publish.screenShareEncoding.maxBitrate,
		);
	});

	it("leaves the camera out of it", async () => {
		const { started } = watchShare();
		const { publish } = await started(60);

		// Publish options are given per share precisely so the camera keeps its
		// own codec. Anything named for the camera appearing here would mean the
		// screen's choice had reached across and changed it.
		expect(publish).not.toHaveProperty("videoEncoding");
		expect(publish).not.toHaveProperty("videoSimulcastLayers");
	});

	it("stops without asking for anything", async () => {
		const { room } = watchShare();
		const stop = room.localParticipant.setScreenShareEnabled as ReturnType<typeof vi.fn>;

		await share(room, false, 30);
		expect(stop).toHaveBeenCalledWith(false, expect.anything(), expect.anything());
	});
});
