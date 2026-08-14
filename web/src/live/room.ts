import {
	type LocalTrackPublication,
	type Participant,
	Room,
	RoomEvent,
	type VideoCodec,
	VideoPresets,
} from "livekit-client";
import type { Join } from "./api";

/**
 * The two ways a screen can be shared.
 *
 * Labelled by frame rate because that is the number people look for, but the
 * choice reaches much further than that. A share of a terminal and a share of a
 * video want opposite answers to every question that follows from it: which
 * encoder tools to use, and which of sharpness and smoothness to give up first
 * when the network cannot carry both. Offering the frame rate alone and deciding
 * the rest centrally would mean deciding it wrong for one of the two.
 */
export const SHARE_FRAME_RATES = [30, 60] as const;
export type ShareFrameRate = (typeof SHARE_FRAME_RATES)[number];

/** Everything that follows from what a share is for. */
interface ShareProfile {
	/** A ceiling, not a target. Congestion control decides the rest. */
	maxBitrate: number;
	/** What the picture is, told to the encoder in its own vocabulary. */
	contentHint: "text" | "motion";
	videoCodec: VideoCodec;
	/** What to sacrifice when the two cannot both be had. */
	degradationPreference: RTCDegradationPreference;
}

/**
 * Neither profile uses VP9, though the camera does and it compresses better.
 *
 * The SDK rewrites a share published with an SVC codec: it pins the stream to a
 * single spatial layer and overwrites `contentHint` with `motion`, working around
 * what its own source calls an untested and buggy path in the browser. The hint
 * below would therefore never reach the encoder, and the sharper of the two
 * profiles is built entirely on that hint. A codec whose advantage is unreachable
 * is not an advantage.
 */
const SHARE_PROFILES: Record<ShareFrameRate, ShareProfile> = {
	// Text, and everything shaped like it: code, a document, slides. The hint is
	// `text` rather than `detail` because the two differ exactly here — both ask
	// for sharp frames over smooth ones, but only `text` lets an encoder reach
	// for the tools it keeps for rendering type.
	//
	// VP8 rather than H.264: software encoding, which a mostly-still screen at
	// thirty frames can afford, and it honours the hint rather than handing the
	// picture to a hardware encoder tuned for faces, where small type is the
	// first thing to go soft.
	30: {
		maxBitrate: 5_000_000,
		contentHint: "text",
		videoCodec: "vp8",
		degradationPreference: "maintain-resolution",
	},

	// Anything that moves: a video, an animation, a demonstration of something
	// being used. Sixty frames of it is more than software encoding should be
	// asked to carry, so this one takes the codec with hardware encoding almost
	// everywhere, and asks to keep the frame rate that was the whole reason for
	// choosing it.
	60: {
		maxBitrate: 8_000_000,
		contentHint: "motion",
		videoCodec: "h264",
		degradationPreference: "maintain-framerate",
	},
};

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
		// Measured against the screen's own pixels rather than the layout's.
		//
		// The quality a tile asks for is its size multiplied by a pixel density,
		// and left unset that density is one on any display denser than the
		// layout but not by more than double — which is every ordinary retina
		// laptop. A stage twelve hundred points wide would therefore ask for
		// twelve hundred pixels and be sent a layer built for it, then paint it
		// across twenty-four hundred. The picture was never sharp because the
		// sharp one was never requested: a shared screen at full resolution
		// needed a stage wider than most people's entire display.
		//
		// The cost is bandwidth, and it buys back the thing the bandwidth was
		// being spent on in the first place.
		adaptiveStream: { pixelDensity: "screen" },
		dynacast: true,
		videoCaptureDefaults: {
			resolution: VideoPresets.h720.resolution,
		},
		publishDefaults: {
			// Layered, so a tile in a nine-up grid can be served something sized
			// for a nine-up grid rather than a full-size picture scaled down at
			// the receiver.
			//
			// The layering is SVC rather than simulcast, which the SDK arranges on
			// its own for VP9: it publishes one stream carrying three spatial and
			// three temporal layers instead of three separate encodes. Setting
			// `simulcast` here would read as a choice and change nothing, since
			// the two are alternatives and the codec has already picked.
			videoCodec: "vp9",
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
	const profile = SHARE_PROFILES[frameRate];

	const published = await room.localParticipant.setScreenShareEnabled(
		wanted,
		{
			audio: true,
			resolution: {
				width: 1920,
				height: 1080,
				frameRate,
			},
			// The picker should not offer this tab, which would be a mirror tunnel.
			selfBrowserSurface: "exclude",
			surfaceSwitching: "include",
			contentHint: profile.contentHint,
		},
		// Given per share rather than left to the room's defaults, which is what
		// keeps the camera out of this: it goes on being sent the way it always
		// was, and only the screen follows the choice made about the screen.
		//
		// This is also where the frame rate finally arrives. Asking the browser to
		// capture sixty means nothing on its own — the encoder has a ceiling of
		// its own, and while it stayed at thirty the second option cost a person
		// twice the capture work to send exactly what the first one sent.
		{
			screenShareEncoding: {
				maxBitrate: profile.maxBitrate,
				maxFramerate: frameRate,
			},
			videoCodec: profile.videoCodec,
			degradationPreference: profile.degradationPreference,
		},
	);

	return published;
}
