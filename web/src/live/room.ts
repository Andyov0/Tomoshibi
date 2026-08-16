import {
	type LocalTrackPublication,
	type Participant,
	Room,
	RoomEvent,
	type VideoCodec,
	VideoPresets,
} from "livekit-client";
import type { Join } from "./api";
import { installNoValidate } from "./novalidate";

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

/**
 * How much picture to send, separately from what kind of picture it is.
 *
 * These were one choice until somebody wanted a sharp share at sixty frames and
 * found that asking for smooth motion also fixed the resolution at 1080p and the
 * ceiling at eight megabits. The two questions are genuinely independent — what
 * is on the screen decides how to encode it, and how much bandwidth there is
 * decides how much of it to send — so they are asked separately now.
 *
 * The heights are what the browser is asked to capture. It is a request rather
 * than a guarantee: a display smaller than the number gets its own size, and a
 * machine that cannot encode what it captured will drop frames or scale down on
 * its own. Nothing here can promise 4K on a laptop that has other ideas.
 */
export const SHARE_QUALITIES = ["standard", "high", "ultra"] as const;
export type ShareQuality = (typeof SHARE_QUALITIES)[number];

interface QualityProfile {
	width: number;
	height: number;
	/**
	 * A ceiling, not a target — congestion control decides the rest, and on a
	 * network that cannot carry this the encoder simply sends less.
	 *
	 * Scaled with the pixels rather than set flat. Four times the area at the
	 * same bitrate is not a sharper picture, it is the same bitrate spread
	 * thinner, which is how a 4K option ends up looking worse than the 1080p one
	 * it replaced.
	 */
	maxBitrate: number;
}

const QUALITY_PROFILES: Record<ShareQuality, QualityProfile> = {
	// What a share was before this existed, and still the right default: 1080p
	// is most people's screen, and eight megabits is more than most uploads have
	// to spare.
	standard: { width: 1920, height: 1080, maxBitrate: 8_000_000 },

	// For a display that has more than 1080p to show and an upload that can
	// carry it. Sixteen megabits for 1.8 times the pixels — deliberately more
	// than proportional, because detail is what somebody choosing this wants and
	// the encoder should not have to choose between it and motion.
	high: { width: 2560, height: 1440, maxBitrate: 16_000_000 },

	// Everything the browser will give. Worth it for a 4K display showing small
	// text, and wasted on anything else: four times the standard area costs four
	// times the encoding, and a machine that cannot keep up drops frames rather
	// than degrading gently.
	ultra: { width: 3840, height: 2160, maxBitrate: 30_000_000 },
};

/** Everything that follows from what a share is for. */
interface ShareProfile {
	/** What the picture is, told to the encoder in its own vocabulary. */
	contentHint: "text" | "motion";
	videoCodec: VideoCodec;
	/** What to sacrifice when the two cannot both be had. */
	degradationPreference: RTCDegradationPreference;
	/**
	 * How much of the quality's ceiling this kind of picture needs.
	 *
	 * A still page of code and a playing video at the same resolution do not
	 * want the same bitrate: most of the code frame is identical to the one
	 * before it and costs almost nothing to send, while the video changes
	 * everywhere at once. Handing both the same ceiling either starves the video
	 * or reserves bandwidth the text was never going to use.
	 *
	 * This was briefly dropped when resolution became its own choice, and an
	 * existing test caught it: the busier picture must keep the larger ceiling.
	 */
	bitrateShare: number;
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
		contentHint: "text",
		videoCodec: "vp8",
		degradationPreference: "maintain-resolution",
		// Two thirds. A mostly-still screen reaches nothing like the ceiling
		// anyway, and leaving the rest unclaimed is bandwidth somebody else's
		// camera can have.
		bitrateShare: 0.65,
	},

	// Anything that moves: a video, an animation, a demonstration of something
	// being used. Sixty frames of it is more than software encoding should be
	// asked to carry, so this one takes the codec with hardware encoding almost
	// everywhere, and asks to keep the frame rate that was the whole reason for
	// choosing it.
	60: {
		contentHint: "motion",
		videoCodec: "h264",
		degradationPreference: "maintain-framerate",
		// All of it. Sixty frames of a picture that changes everywhere is the
		// case the ceiling was chosen for.
		bitrateShare: 1,
	},
};

/**
 * What to send, given both choices.
 *
 * VP8 above 1080p is the one combination that has to be overridden. Software
 * encoding 1440p or 4K at thirty frames asks more of a CPU than most have, and
 * the failure is not a softer picture — it is an encoder falling behind, which
 * arrives as a share that stutters and lags further behind the longer it runs.
 * H.264 has hardware encoding almost everywhere and keeps up.
 */
export function settingsForTest(frameRate: ShareFrameRate, quality: ShareQuality) {
	return settingsFor(frameRate, quality);
}

function settingsFor(frameRate: ShareFrameRate, quality: ShareQuality) {
	const profile = SHARE_PROFILES[frameRate];
	const size = QUALITY_PROFILES[quality];

	const videoCodec: VideoCodec =
		profile.videoCodec === "vp8" && size.height > 1080 ? "h264" : profile.videoCodec;

	return {
		...profile,
		...size,
		videoCodec,
		maxBitrate: Math.round(size.maxBitrate * profile.bitrateShare),
	};
}

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
	// Before anything can connect, because the request it removes is made by
	// the SDK during a failed connection and there is no later moment to do
	// it in.
	installNoValidate();

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
	quality: ShareQuality = "standard",
): Promise<LocalTrackPublication | undefined> {
	const profile = settingsFor(frameRate, quality);

	const published = await room.localParticipant.setScreenShareEnabled(
		wanted,
		{
			audio: true,
			resolution: {
				width: profile.width,
				height: profile.height,
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

/**
 * Where the chosen quality is remembered.
 *
 * A person's answer to this follows from their display and their upload, and
 * neither changes between meetings. Asking again every time would be asking a
 * question whose answer they already gave.
 *
 * Local storage rather than session: it belongs to the machine, which is the
 * thing that decides it.
 */
const QUALITY_KEY = "meet.share.quality";

/** The quality to use, as last chosen on this machine. */
export function rememberedQuality(): ShareQuality {
	try {
		const stored = localStorage.getItem(QUALITY_KEY);
		if (stored && (SHARE_QUALITIES as readonly string[]).includes(stored)) {
			return stored as ShareQuality;
		}
	} catch {
		// Storage can be unavailable — a private window, a blocked origin — and
		// a share should still be possible when it is.
	}

	return "standard";
}

/** Remember a quality for next time. */
export function rememberQuality(quality: ShareQuality): void {
	try {
		localStorage.setItem(QUALITY_KEY, quality);
	} catch {
		// As above: worth doing, never worth failing over.
	}
}
