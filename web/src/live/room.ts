import {
	type LocalTrackPublication,
	type Participant,
	Room,
	RoomEvent,
	VideoPresets,
} from "livekit-client";
import type { Join } from "./api";

/** Frame rates offered for screen sharing. */
export const SHARE_FRAME_RATES = [30, 60] as const;
export type ShareFrameRate = (typeof SHARE_FRAME_RATES)[number];

/**
 * Build the room.
 *
 * Adaptive streaming and dynacast are both on, and together they are the reason
 * a busy meeting does not cost what it looks like it should: adaptive streaming
 * drops the quality of a track to what its tile actually needs, and dynacast
 * stops the publisher encoding a layer nobody is watching. The second one is
 * paid for by whoever is sending, which is the side with the least bandwidth to
 * spare.
 */
export function create(): Room {
	return new Room({
		adaptiveStream: true,
		dynacast: true,
		videoCaptureDefaults: {
			resolution: VideoPresets.h720.resolution,
		},
		publishDefaults: {
			// Three layers, so a tile in a nine-up grid can be served something
			// sized for a nine-up grid rather than a full-size picture scaled
			// down at the receiver.
			simulcast: true,
			videoCodec: "vp9",
			// Screen content is mostly still, and its motion is scrolling rather
			// than a face moving. Telling the encoder that spends the bitrate on
			// legible text instead of temporal smoothness.
			screenShareEncoding: {
				maxBitrate: 4_000_000,
				maxFramerate: 30,
			},
		},
		// Speaking is worked out by the media server and pushed to everybody, so
		// no client has to run an analyser of its own.
		disconnectOnPageLeave: true,
	});
}

/**
 * Connect.
 *
 * The display name is already in the token, so there is nothing to set
 * afterwards. Setting it here would need a permission this grant deliberately
 * withholds, and the server would refuse.
 */
export async function connect(room: Room, grant: Join): Promise<void> {
	await room.connect(grant.url, grant.token);
}

/**
 * Everybody in the room, ourselves included and first.
 *
 * Ourselves first because the self view belongs on the first page: losing sight
 * of your own camera because the room got busy is disorienting, and it costs
 * nothing since it renders from the local capture.
 */
export function roster(room: Room): Participant[] {
	return [room.localParticipant, ...room.remoteParticipants.values()];
}

/** Events that change what the layout should show. */
export const ROSTER_EVENTS = [
	RoomEvent.ParticipantConnected,
	RoomEvent.ParticipantDisconnected,
	RoomEvent.TrackPublished,
	RoomEvent.TrackUnpublished,
	RoomEvent.TrackSubscribed,
	RoomEvent.TrackUnsubscribed,
	RoomEvent.TrackMuted,
	RoomEvent.TrackUnmuted,
	RoomEvent.LocalTrackPublished,
	RoomEvent.LocalTrackUnpublished,
	RoomEvent.ParticipantNameChanged,
	RoomEvent.ActiveSpeakersChanged,
	RoomEvent.ConnectionStateChanged,
] as const;

/**
 * Start or stop sharing the screen.
 *
 * Separate from the camera rather than replacing it, so both can be on at once,
 * which is the whole point of treating pictures rather than people as the unit
 * of layout. Audio comes along because a shared video with no sound is a common
 * and confusing failure.
 */
export async function share(
	room: Room,
	wanted: boolean,
	frameRate: ShareFrameRate,
): Promise<LocalTrackPublication | undefined> {
	const published = await room.localParticipant.setScreenShareEnabled(wanted, {
		audio: true,
		resolution: {
			width: 1920,
			height: 1080,
			frameRate,
		},
		// The picker should not offer this tab, which would be a mirror tunnel.
		selfBrowserSurface: "exclude",
		surfaceSwitching: "include",
		contentHint: frameRate >= 60 ? "motion" : "detail",
	});

	return published;
}
