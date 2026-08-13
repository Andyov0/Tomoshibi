import { audioBlocked } from "@/live/notices";
import { RoomAudioRenderer, useAudioPlayback } from "@livekit/components-react";
import type { Room } from "livekit-client";
import { useEffect } from "react";

/**
 * Everything the room sounds like.
 *
 * Voices are not part of the layout, so nothing on screen renders them, and
 * without this the call is silent while every other sign of life — the tally,
 * the microphone icon, the level on somebody's own meter — says it is working.
 * That is the worst shape a fault can take, so the sound gets its own component
 * rather than being tucked inside a tile that might not be on the page.
 *
 * The renderer is the library's own: it follows microphones and shared system
 * audio, skips the local participant so nobody hears themselves, and keeps
 * playing while the speaker's tile is paged away or hidden behind a share.
 *
 * Passed the room directly rather than through a provider, which is what makes
 * it usable here at all — this application holds its room itself and puts no
 * context above the tree.
 */
export function Audible({ room }: { room: Room }) {
	const { canPlayAudio, startAudio } = useAudioPlayback(room);

	// Browsers refuse to play sound a person did not ask for. Joining is
	// normally gesture enough, so this stays quiet in the ordinary case and
	// speaks up only where the browser actually held the audio back.
	useEffect(() => {
		if (canPlayAudio) return;

		return audioBlocked(() => {
			void startAudio();
		});
	}, [canPlayAudio, startAudio]);

	return <RoomAudioRenderer room={room} />;
}
