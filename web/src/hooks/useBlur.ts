import { blur, possible, remember, wanted } from "@/live/blur";
import { type LocalVideoTrack, type Room, RoomEvent, Track } from "livekit-client";
import { useCallback, useEffect, useState } from "react";

/**
 * Blurring the background, for as long as somebody is in a call.
 *
 * Held here rather than in the menu that has the switch, for the same reason
 * the door is watched from the room rather than from the panel: the menu is a
 * dropdown, so anything living inside it exists only while it is open. A
 * preference read there would be read once, when somebody happened to look.
 *
 * What this has to survive is a camera going off and coming back on, and a
 * different camera being chosen. Both replace the track, and a processor is a
 * property of a track — so the blur somebody turned on before the call would
 * quietly stop applying at the first device change, which is the failure this
 * watches for. The publication is re-read on every local track change and the
 * choice is applied again.
 */
export function useBlur(room: Room) {
	const [on, setOn] = useState(() => wanted());
	const [busy, setBusy] = useState(false);

	const camera = useCallback(
		(): LocalVideoTrack | undefined =>
			room.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack as
				| LocalVideoTrack
				| undefined,
		[room],
	);

	// Applied to whatever camera track is live now, whenever that changes.
	//
	// A track arriving already blurred is left alone: setProcessor on a track
	// that has one tears the old one down and builds another, which is a visible
	// stutter for no change.
	useEffect(() => {
		let live = true;

		const apply = () => {
			const track = camera();
			if (!track || !on) return;
			if (track.getProcessor()) return;

			void blur(track, true).then((worked) => {
				if (live && !worked) setOn(false);
			});
		};

		apply();

		room.on(RoomEvent.LocalTrackPublished, apply);
		room.on(RoomEvent.TrackMuted, apply);
		room.on(RoomEvent.TrackUnmuted, apply);

		return () => {
			live = false;
			room.off(RoomEvent.LocalTrackPublished, apply);
			room.off(RoomEvent.TrackMuted, apply);
			room.off(RoomEvent.TrackUnmuted, apply);
		};
	}, [camera, on, room]);

	const toggle = useCallback(async () => {
		const track = camera();
		const wants = !on;

		// Remembered whether or not there is a camera to apply it to. Somebody
		// turning this on with their camera off has said what they want, and the
		// track that comes up later is the one that has to honour it.
		remember(wants);
		setOn(wants);

		if (!track) return;

		setBusy(true);

		try {
			const now = await blur(track, wants);

			if (now !== wants) {
				remember(now);
				setOn(now);
			}
		} finally {
			setBusy(false);
		}
	}, [camera, on]);

	return { possible: possible(), on, busy, toggle };
}
