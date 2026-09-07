import {
	type ElementInfo,
	type RemoteTrackPublication,
	RemoteVideoTrack,
	type Room,
	RoomEvent,
	Track,
} from "livekit-client";

/**
 * A shared screen is subscribed to at full size, whatever size its tile is.
 *
 * Adaptive streaming lowers what a track is sent at to what its tile needs,
 * which is right for a camera and wrong for a screen. Nobody chose the
 * resolution of a face in a nine-up grid and a smaller one costs nothing worth
 * having. A shared screen is the opposite: somebody chose its size, everybody is
 * looking at it, and the content is text — one delivered at the size of its
 * tile is one that was not shared.
 *
 * ## Why the obvious way does not work, and this does
 *
 * There was a version of this file that called `setVideoQuality(HIGH)` and
 * `setVideoDimensions(source)`. Both were inert, and the second could only ever
 * lower a subscription it was meant to raise. RemoteTrackPublication builds its
 * UpdateTrackSettings by taking the *smaller* of what was requested and what
 * adaptive stream measured (livekit-client.esm.mjs:31104-31112, via
 * areDimensionsSmaller), and `settings.quality` is sent only when no dimensions
 * are known at all — which, with adaptive stream on, never happens. There is no
 * supported per-track switch: `adaptiveStreamSettings` is private, and turning
 * the feature off is a room-wide setting that would take the camera with it.
 *
 * What is reachable is the measurement itself. `updateDimensions` takes the
 * **maximum** over every observed element (esm.mjs:15301-15313), so observing
 * one more that reports the share's own size makes the maximum the source size,
 * and the tile can no longer decide anything. The rungs beneath the top one are
 * then reached the way they were always meant to be — by congestion, and by
 * nothing else.
 *
 * The stub is not an element, and does not have to be: ElementInfo is an
 * exported interface, and the only things ever asked of it are `width()`,
 * `height()`, the two flags, and the two no-op lifecycle calls.
 *
 * ## What it costs, said plainly
 *
 * More downstream for anybody watching a share in a small window, and more
 * egress from the server for the same reason. That is the trade this file
 * exists to make, and it is the one that was asked for: the alternative spends
 * a publisher's whole upload — the scarce thing on the connections this has to
 * work on — on a picture that arrives unreadable.
 *
 * Background pause survives: `updateVisibility` still fails closed on
 * `isInBackground` regardless of what any element reports
 * (esm.mjs:15285-15288), so a share in a tab nobody is looking at is still
 * paused.
 */

/** What to claim when the publication has not said how big the source is yet. */
const ASSUME = { width: 3840, height: 2160 };

export function sharpShares(room: Room): () => void {
	// One per track, so a re-subscribe does not stack them and a departure can
	// take its own back.
	const held = new Map<string, ElementInfo>();

	const fix = (publication: RemoteTrackPublication) => {
		if (publication.source !== Track.Source.ScreenShare) return;
		if (publication.kind !== Track.Kind.Video) return;

		// The remote kind specifically: only that one is observed, and only that
		// one has the methods. A local publication reaching here would be this
		// client's own share, which nothing subscribes to.
		const track = publication.videoTrack;
		if (!(track instanceof RemoteVideoTrack) || held.has(publication.trackSid)) return;

		// Read at each call rather than captured: the dimensions arrive with the
		// track info and can change when somebody switches the shared surface.
		const measured: ElementInfo = {
			// Required by the type and never compared against anything real:
			// `attach` dedupes on `info.element === element`, and a bare object
			// is equal to no element.
			element: {},
			width: () => publication.dimensions?.width ?? ASSUME.width,
			height: () => publication.dimensions?.height ?? ASSUME.height,
			visible: true,
			pictureInPicture: false,
			visibilityChangedAt: 0,
			observe() {},
			stopObserving() {},
		};

		try {
			track.observeElementInfo(measured);
			held.set(publication.trackSid, measured);
		} catch {
			// A build where this is no longer reachable. The share is then
			// subscribed the way everything else is, which is the behaviour this
			// file exists to change but is not a broken call.
		}
	};

	const forget = (publication: RemoteTrackPublication) => {
		const measured = held.get(publication.trackSid);
		if (!measured) return;

		held.delete(publication.trackSid);

		const track = publication.videoTrack;
		if (!(track instanceof RemoteVideoTrack)) return;

		try {
			track.stopObservingElementInfo(measured);
		} catch {
			// Gone with the track it belonged to.
		}
	};

	const onSubscribed = (_t: unknown, publication: RemoteTrackPublication) => fix(publication);
	const onUnsubscribed = (_t: unknown, publication: RemoteTrackPublication) => forget(publication);
	const onUnpublished = (publication: RemoteTrackPublication) => forget(publication);

	// Every share already in the room, for somebody joining a meeting where the
	// sharing started before they arrived.
	for (const participant of room.remoteParticipants.values()) {
		for (const publication of participant.trackPublications.values()) fix(publication);
	}

	room.on(RoomEvent.TrackSubscribed, onSubscribed);
	room.on(RoomEvent.TrackUnsubscribed, onUnsubscribed);
	room.on(RoomEvent.TrackUnpublished, onUnpublished);

	return () => {
		room.off(RoomEvent.TrackSubscribed, onSubscribed);
		room.off(RoomEvent.TrackUnsubscribed, onUnsubscribed);
		room.off(RoomEvent.TrackUnpublished, onUnpublished);

		// Whatever is still held goes back, so a room left behind is not still
		// being measured by something this file owns.
		for (const participant of room.remoteParticipants.values()) {
			for (const publication of participant.trackPublications.values()) forget(publication);
		}

		held.clear();
	};
}
