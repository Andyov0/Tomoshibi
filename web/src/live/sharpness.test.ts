import { RemoteVideoTrack, RoomEvent, Track } from "livekit-client";
import { describe, expect, it } from "vitest";

import { sharpShares } from "./sharpness";

/*
What this guards, and why it cannot be checked by reading the code.

The fault it exists for was invisible from every direction: a share arrived at
the size of its tile, which looks like a share, and the two calls that were
supposed to prevent it were both inert. So the thing worth testing is not that
some function was called — it is that the measurement handed to the SDK reports
the *source* size rather than the element's, because that number is the whole
mechanism. `updateDimensions` takes the maximum over observed elements, so a
share is held at full size exactly as long as this one is the largest.

The camera half matters just as much in the other direction. Adaptive streaming
is right for a face in a small tile, and quietly disabling it for every track
would cost a busy meeting a great deal of downstream for pixels nobody can see.
*/

/** Enough of a RemoteVideoTrack for the code under test, and nothing more. */
function fakeTrack() {
	const observed: { width: number; height: number; visible: boolean }[] = [];
	const stopped: unknown[] = [];

	const track = Object.create(RemoteVideoTrack.prototype) as RemoteVideoTrack & {
		observeElementInfo: (info: {
			width(): number;
			height(): number;
			visible: boolean;
		}) => void;
		stopObservingElementInfo: (info: unknown) => void;
	};

	track.observeElementInfo = (info) => {
		observed.push({ width: info.width(), height: info.height(), visible: info.visible });
	};
	track.stopObservingElementInfo = (info) => {
		stopped.push(info);
	};

	return { track, observed, stopped };
}

function fakeRoom(publications: unknown[]) {
	const handlers = new Map<string, ((...a: never[]) => void)[]>();

	const room = {
		remoteParticipants: new Map([["p", { trackPublications: new Map(publications.map((p, i) => [String(i), p])) }]]),
		on(event: string, handler: (...a: never[]) => void) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return room;
		},
		off() {
			return room;
		},
	};

	return { room, handlers };
}

describe("a shared screen is held at its own size", () => {
	it("reports the source size to the measurement, not the tile's", () => {
		const { track, observed } = fakeTrack();

		const publication = {
			source: Track.Source.ScreenShare,
			kind: Track.Kind.Video,
			trackSid: "TR_1",
			videoTrack: track,
			dimensions: { width: 2560, height: 1440 },
		};

		// biome-ignore lint: the fake is deliberately narrow
		const { room } = fakeRoom([publication]) as any;
		sharpShares(room);

		// The number that decides everything. The server picks the smallest layer
		// at least `height * 0.9` tall, so anything smaller than the source here
		// is a share delivered at the size of somebody's window.
		expect(observed).toEqual([{ width: 2560, height: 1440, visible: true }]);
	});

	it("claims a large size before the source has said how big it is", () => {
		const { track, observed } = fakeTrack();

		const publication = {
			source: Track.Source.ScreenShare,
			kind: Track.Kind.Video,
			trackSid: "TR_2",
			videoTrack: track,
			dimensions: undefined,
		};

		// biome-ignore lint: as above
		const { room } = fakeRoom([publication]) as any;
		sharpShares(room);

		// Erring downward here would be a share that starts at thumbnail size and
		// only recovers once the dimensions arrive, which is the first thing
		// anybody sees.
		expect(observed[0]?.width).toBeGreaterThanOrEqual(1920);
		expect(observed[0]?.height).toBeGreaterThanOrEqual(1080);
	});

	it("leaves the camera to adaptive streaming", () => {
		const { track, observed } = fakeTrack();

		const publication = {
			source: Track.Source.Camera,
			kind: Track.Kind.Video,
			trackSid: "TR_3",
			videoTrack: track,
			dimensions: { width: 1280, height: 720 },
		};

		// biome-ignore lint: as above
		const { room } = fakeRoom([publication]) as any;
		sharpShares(room);

		// A face in a nine-up grid loses nothing worth having by being sent
		// small, and holding every camera at full size is what makes a busy
		// meeting cost what it looks like it should.
		expect(observed).toEqual([]);
	});

	it("subscribes to the events that bring a share that started later", () => {
		// biome-ignore lint: as above
		const { room, handlers } = fakeRoom([]) as any;
		sharpShares(room);

		expect(handlers.has(RoomEvent.TrackSubscribed)).toBe(true);
		expect(handlers.has(RoomEvent.TrackUnsubscribed)).toBe(true);
	});
});
