import {
	type RemoteTrackPublication,
	type Room,
	RoomEvent,
	Track,
	VideoQuality,
} from "livekit-client";

/**
 * A shared screen is subscribed to at full quality, whatever size its tile is.
 *
 * Adaptive streaming lowers what a track is sent at to what its tile actually
 * needs, which is right for a camera and wrong for a screen. Nobody chose the
 * resolution of a face in a nine-up grid and a smaller one costs nothing worth
 * having. A shared screen is the opposite: somebody chose its size, everybody
 * is looking at it, and the content is text — one delivered at the size of its
 * thumbnail is one that was not shared.
 *
 * That is what "it keeps dropping to 720p" is. The tile is a few hundred pixels
 * wide until somebody pins it, so this client asks for a layer to match and the
 * publisher is told nobody needs the full picture.
 *
 * The camera is left alone: this is one exception, made where the reasoning
 * behind the rule does not hold.
 *
 * ## What it costs
 *
 * A share is carried at full bitrate even in a small tile, so a busy meeting
 * with somebody sharing costs more to receive than it did. That is the right
 * way round. The alternative spends a publisher's whole upload — which on the
 * connections this has to work on is the scarce thing — on a picture that
 * arrives unreadable.
 */
export function sharpShares(room: Room): () => void {
	const fix = (publication: RemoteTrackPublication) => {
		if (publication.source !== Track.Source.ScreenShare) return;
		if (publication.kind !== Track.Kind.Video) return;

		try {
			// Which simulcast layer, for a publisher sending several. A share
			// here is published without simulcast, so this does nothing today
			// and is what keeps this right if that changes.
			publication.setVideoQuality(VideoQuality.HIGH);

			// And the size, which is what adaptive streaming would otherwise
			// work out from the tile. The SDK says setting it explicitly takes
			// precedence over what it measured, which is the whole point.
			publication.setVideoDimensions({
				width: publication.dimensions?.width ?? 3840,
				height: publication.dimensions?.height ?? 2160,
			});
		} catch {
			// Not subscribed yet, which the SDK refuses rather than queues. The
			// event that brings the subscription runs this again.
		}
	};

	const onSubscribed = (_track: unknown, publication: RemoteTrackPublication) => fix(publication);
	const onPublished = (publication: RemoteTrackPublication) => fix(publication);

	// Every share already in the room, for somebody joining a meeting where the
	// sharing started before they arrived.
	for (const participant of room.remoteParticipants.values()) {
		for (const publication of participant.trackPublications.values()) {
			fix(publication);
		}
	}

	room.on(RoomEvent.TrackSubscribed, onSubscribed);
	room.on(RoomEvent.TrackPublished, onPublished);

	// The same references, or nothing is removed and a room left behind goes on
	// being written to.
	return () => {
		room.off(RoomEvent.TrackSubscribed, onSubscribed);
		room.off(RoomEvent.TrackPublished, onPublished);
	};
}
