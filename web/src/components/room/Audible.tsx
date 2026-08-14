import { SOUNDS, SOURCE, settingFor, subscribe } from "@/live/hearing";
import { audioBlocked } from "@/live/notices";
import { RoomAudioRenderer, useAudioPlayback } from "@livekit/components-react";
import { type Room, RoomEvent } from "livekit-client";
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
 * playing while the speaker's tile is paged away or hidden behind a share. It is
 * left with no volume of its own, because the one it takes is applied to every
 * track at once and would overwrite the settings below on every render.
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

	// What anybody has decided about hearing other people, kept applied.
	useEffect(() => {
		const put = () => apply(room);

		// At once, because a participant already in the room when this mounts
		// announces nothing: the events below are all about things that change
		// afterwards.
		put();

		for (const event of HEARING_EVENTS) room.on(event, put);
		const stop = subscribe(put);

		return () => {
			for (const event of HEARING_EVENTS) room.off(event, put);
			stop();
		};
	}, [room]);

	return <RoomAudioRenderer room={room} />;
}

/**
 * When the media library may have forgotten what it was told.
 *
 * A volume is kept on the participant and a block on the publication, and both
 * of those are rebuilt from nothing more often than one would think: a full
 * reconnect disconnects and re-adds every remote participant, and a share
 * stopped and started again is a new publication. Every one of those arrives as
 * one of these.
 *
 * Muting is not among them. Somebody covering their microphone does not replace
 * a publication, so nothing is lost and re-applying would be a message to the
 * media server for no reason.
 */
const HEARING_EVENTS = [
	RoomEvent.ParticipantConnected,
	RoomEvent.TrackPublished,
	RoomEvent.TrackSubscribed,
] as const;

/**
 * Put every setting back on the room.
 *
 * All of them, every time, rather than working out which one this event was
 * about. The book holds an entry per person per sound and is nearly always
 * empty; deciding which entry a given event invalidated would be more code than
 * this and would be wrong in the case nobody thought of.
 */
function apply(room: Room): void {
	for (const participant of room.remoteParticipants.values()) {
		for (const sound of SOUNDS) {
			const source = SOURCE[sound];
			const setting = settingFor(participant.identity, sound);

			// Kept on the participant rather than the track, so it is waiting
			// for a microphone that has not been turned on yet.
			participant.setVolume(setting.volume, source);

			const publication = participant.getTrackPublication(source);

			// Only where it differs, because this one leaves the machine: every
			// call with a new answer sends the media server a settings update,
			// and this runs for everybody in the room on every arrival.
			if (publication && publication.isEnabled === setting.blocked) {
				publication.setEnabled(!setting.blocked);
			}
		}
	}
}
