import {
	type LocalTrackPublication,
	type Participant,
	Room,
	RoomEvent,
	Track,
	type VideoCodec,
	VideoPresets,
} from "livekit-client";
import type { Join } from "./api";
import { installNoValidate } from "./novalidate";

/**
 * What a screen share is, as two questions.
 *
 * How large a picture, and how many frames of it. They were one choice once and
 * that was wrong in both directions: asking for smooth motion also fixed the
 * resolution and the ceiling, and asking for a sharp picture fixed the frame
 * rate at thirty. They are independent — the size follows from the display, the
 * rate follows from what is on it — so they are asked separately, with the rates
 * a given size can actually carry.
 *
 * And an automatic setting, which is the only one that gives ground. Everything
 * else is somebody saying what they want and is sent at the ceiling for it.
 */
export const SHARE_QUALITIES = ["auto", "1080p", "1440p", "4k"] as const;
export type ShareQuality = (typeof SHARE_QUALITIES)[number];

export const SHARE_FRAME_RATES = [15, 30, 60, 120, 240] as const;
export type ShareFrameRate = (typeof SHARE_FRAME_RATES)[number];

/**
 * How many frames each size can be asked for.
 *
 * Ceilings rather than preferences, and they come from what an encoder can
 * actually do rather than from taste. Every rate below a size's ceiling is
 * offered, because a slow rate is always available: somebody sharing a page of
 * code at 4K wants fifteen frames and the sharpest possible picture, and
 * refusing them that would be refusing the better answer.
 *
 * What is not offered is a combination that cannot be delivered. 4K at 120
 * frames is a billion pixels a second; the encoder does not fail loudly, it
 * falls behind, and a share that drifts further behind the longer it runs is
 * worse than one that was never offered.
 */
const RATES_FOR: Record<Exclude<ShareQuality, "auto">, readonly ShareFrameRate[]> = {
	"1080p": [15, 30, 60, 120, 240],
	"1440p": [15, 30, 60, 120],
	"4k": [15, 30, 60],
};

/** The frame rates this size may be asked for. */
export function ratesFor(quality: ShareQuality): readonly ShareFrameRate[] {
	return quality === "auto" ? SHARE_FRAME_RATES : RATES_FOR[quality];
}

/** Whether a pairing is one this offers at all. */
export function offers(quality: ShareQuality, frameRate: ShareFrameRate): boolean {
	return ratesFor(quality).includes(frameRate);
}

interface Size {
	width: number;
	height: number;
}

const SIZES: Record<Exclude<ShareQuality, "auto">, Size> = {
	"1080p": { width: 1920, height: 1080 },
	"1440p": { width: 2560, height: 1440 },
	"4k": { width: 3840, height: 2160 },
};

/**
 * What automatic sends.
 *
 * 1080p at thirty, and the only mode that gives ground: the bitrate floats, the
 * encoder may drop resolution, and somebody on a bad connection ends up with a
 * smaller picture rather than a stalled one.
 *
 * Every other choice is a person saying what they want, and is sent at the
 * ceiling for it. That is the whole distinction: automatic is for somebody who
 * does not want to think about it, and the named sizes are for somebody who
 * does and has already decided.
 */
const AUTOMATIC = { width: 1920, height: 1080, frameRate: 30 as ShareFrameRate };

/**
 * How many bits a picture of this size and rate is worth.
 *
 * Roughly a tenth of a bit per pixel per frame, which is about what H.264 wants
 * for screen content — text and flat colour compress far better than camera
 * noise, and the number is chosen for the moment a page scrolls rather than for
 * the seconds it sits still.
 *
 * Scaled with both dimensions rather than set per size, because the failure it
 * prevents is the same either way: four times the pixels at the same ceiling is
 * not a sharper picture but the same bitrate spread thinner, and eight times the
 * frames at the same ceiling is every frame getting an eighth of the data.
 *
 * Capped, because the curve keeps going and networks do not. 1080p at 240 and 4K
 * at 60 both land near the cap, which is the right place for them to land: past
 * it, the limit is not this number.
 */
const BITS_PER_PIXEL_PER_FRAME = 0.1;
const BITRATE_CAP = 60_000_000;
const BITRATE_FLOOR = 2_500_000;

function bitrateFor(width: number, height: number, frameRate: number): number {
	const wanted = width * height * frameRate * BITS_PER_PIXEL_PER_FRAME;

	return Math.round(Math.min(BITRATE_CAP, Math.max(BITRATE_FLOOR, wanted)));
}

/**
 * What to send, given both choices.
 *
 * The codec is H.264 everywhere except a still 1080p picture. H.264 has
 * hardware encoding on essentially every machine, and above 1080p or above
 * thirty frames the alternative is not a softer picture but an encoder falling
 * behind — which arrives as a share that stutters and drifts, and never
 * announces itself.
 *
 * VP8 is kept for 1080p at fifteen or thirty because it honours the `text`
 * content hint, and a hardware H.264 encoder tuned for faces makes small type
 * the first thing to go soft. That is a real difference on a page of code, and
 * it is affordable at that size and rate and at no other.
 *
 * Nothing here is a promise. The heights are what the browser is asked to
 * capture: a smaller display gives its own size, and a machine that cannot
 * encode what it captured will scale down on its own.
 */
export function settingsForTest(frameRate: ShareFrameRate, quality: ShareQuality) {
	return settingsFor(frameRate, quality);
}

function settingsFor(frameRate: ShareFrameRate, quality: ShareQuality) {
	if (quality === "auto") {
		return {
			...AUTOMATIC,
			frameRate: AUTOMATIC.frameRate,
			maxBitrate: bitrateFor(AUTOMATIC.width, AUTOMATIC.height, AUTOMATIC.frameRate),
			videoCodec: "h264" as VideoCodec,
			contentHint: "detail" as const,
			// The one mode that gives ground, and it gives resolution first:
			// somebody who did not choose a size is better served by a smaller
			// picture that keeps up than a large one that stalls.
			degradationPreference: "balanced" as RTCDegradationPreference,
			adapts: true,
		};
	}

	const size = SIZES[quality];

	// Clamped rather than refused. A rate remembered from a larger allowance —
	// 240 chosen at 1080p and then 4K picked — would otherwise be sent to an
	// encoder that cannot do it, and the failure is silent.
	const rates = RATES_FOR[quality];
	const capped = rates.includes(frameRate) ? frameRate : (rates[rates.length - 1] ?? 30);

	const still = capped <= 30;

	return {
		...size,
		frameRate: capped,
		maxBitrate: bitrateFor(size.width, size.height, capped),
		videoCodec: (still && size.height <= 1080 ? "vp8" : "h264") as VideoCodec,
		contentHint: (still ? "text" : "motion") as "text" | "motion" | "detail",
		// Never smaller than was asked for. Somebody who picked a size picked it,
		// and quietly sending less is the complaint rather than the mitigation —
		// so what gives, where something must, is the frame rate.
		degradationPreference: "maintain-resolution" as RTCDegradationPreference,
		adapts: false,
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
/**
 * The token each connected room was authorised with.
 *
 * Kept here because the host's own requests need it — it is the only thing that
 * proves, without a session, which room and which identity they are — and
 * because the SDK's copy is a private field. Private is not a runtime guarantee
 * and reading it would work, right up until a minified build renamed it and the
 * host controls stopped authorising with no error anywhere that says why.
 *
 * A WeakMap rather than a field on the room, so nothing here keeps a disconnected
 * room alive and so the token goes when the room does.
 */
const tokens = new WeakMap<Room, string>();

/** The token a room was joined with, for the requests that have to prove it. */
export function tokenFor(room: Room): string {
	return tokens.get(room) ?? "";
}

export async function connect(room: Room, grant: Join): Promise<void> {
	tokens.set(room, grant.token);

	if (!grant.forward) {
		await room.connect(grant.url, grant.token);
		return;
	}

	/*
	 * Media through the relay that was picked, rather than past it.
	 *
	 * The server sends this only when the room is being held on a different
	 * machine from the one this client chose. Left alone the browser would
	 * gather its own candidates and connect straight to the holder, so the
	 * chosen relay would carry the signalling and none of the call — which is
	 * the same as not having chosen.
	 *
	 * `relay` is the whole of it. Offering the relay alongside the direct route
	 * would mean the browser tries both and keeps whichever answers first, and
	 * the direct one always answers first: the setting would appear to work,
	 * change nothing, and be very hard to argue with afterwards.
	 *
	 * The server's own list is replaced rather than added to, which the SDK
	 * allows explicitly — it fills in the servers from the join response only
	 * when none were given here. Read out of `livekit-client.esm.mjs`, because
	 * this is the kind of thing a release note does not mention and a call
	 * failing to connect does not explain.
	 */
	await room.connect(grant.url, grant.token, {
		rtcConfig: {
			iceServers: [
				{
					urls: grant.forward.url,
					username: grant.forward.username,
					credential: grant.forward.credential,
				},
			],
			iceTransportPolicy: "relay",
		},
	});
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
	quality: ShareQuality = "auto",
): Promise<LocalTrackPublication | undefined> {
	const profile = settingsFor(frameRate, quality);

	const published = await room.localParticipant.setScreenShareEnabled(
		wanted,
		{
			audio: true,
			resolution: {
				width: profile.width,
				height: profile.height,
				// The clamped rate, not what was asked for: a rate remembered
				// from a size that allowed it would otherwise be requested from a
				// capture that cannot do it, and the browser answers by giving
				// whatever it likes rather than by saying no.
				frameRate: profile.frameRate,
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
				maxFramerate: profile.frameRate,
			},
			videoCodec: profile.videoCodec,
			degradationPreference: profile.degradationPreference,

			// One encode, at the size that was asked for.
			//
			// A share is published with simulcast by default: two encodes of the
			// same screen, and a subscriber whose tile is small — or whose
			// connection dips — is served the smaller one. That is right for a
			// camera, where nobody chose the resolution and a worse picture is
			// better than a stall.
			//
			// It is wrong here, twice over. Somebody who picked 4K picked it,
			// and being quietly given 1080p instead is the complaint rather than
			// the mitigation. And the second encode is not free: at four times
			// the pixels it is what makes a software encoder fall behind, which
			// arrives as a share that stutters and drifts — so the machinery for
			// coping with a slow connection was itself the reason the picture
			// was slow.
			//
			// The bitrate still adapts. What stops is switching to a smaller
			// picture behind the person who chose one.
			// One encode for anything chosen, and layers only for automatic.
			//
			// A share is published with simulcast by default: two encodes of the
			// same screen, so a subscriber whose tile is small or whose network
			// dips is served the smaller one. That is what automatic is for, and
			// it is exactly wrong for a size somebody picked — being quietly
			// handed 1080p after choosing 4K is the complaint rather than the
			// mitigation. The second encode is also not free: at four times the
			// pixels it is what makes an encoder fall behind, so the machinery
			// for coping with a slow connection was itself making the picture
			// slow.
			simulcast: profile.adapts,
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

	return "auto";
}

/** Remember a quality for next time. */
export function rememberQuality(quality: ShareQuality): void {
	try {
		localStorage.setItem(QUALITY_KEY, quality);
	} catch {
		// As above: worth doing, never worth failing over.
	}
}

/**
 * Where the chosen frame rate is remembered.
 *
 * Beside the size rather than with it, because they change for different
 * reasons: the size follows from the display and almost never moves, and the
 * rate follows from what is being shown and moves whenever that does.
 *
 * Read back through the same clamp the settings use, so a rate stored while a
 * larger size was chosen cannot come back and be sent to an encoder that cannot
 * do it.
 */
const RATE_KEY = "meet-live.share-frame-rate";

export function rememberedFrameRate(): ShareFrameRate {
	try {
		const stored = Number(localStorage.getItem(RATE_KEY));
		if ((SHARE_FRAME_RATES as readonly number[]).includes(stored)) {
			return stored as ShareFrameRate;
		}
	} catch {
		// Storage can be unavailable, and a share should still be possible.
	}

	return 30;
}

export function rememberFrameRate(frameRate: ShareFrameRate): void {
	try {
		localStorage.setItem(RATE_KEY, String(frameRate));
	} catch {
		// Worth doing, never worth failing over.
	}
}

/**
 * Change a share's settings without asking for the screen again.
 *
 * The obvious way to apply a new size or frame rate is to publish the share
 * again with different options, and it cannot be done: the browser will not
 * hand back a capture without asking, so every adjustment would put the picker
 * in front of somebody who had already chosen a window — and if they picked the
 * wrong one in a hurry, the meeting has just watched them do it. In practice
 * that means the settings can only be chosen before a share starts, which is
 * exactly when somebody has the least idea whether they are right.
 *
 * So the capture is kept and re-tuned in place, in two parts, because they are
 * two different mechanisms and only one of them is the one that matters:
 *
 *   - the capture, through `applyConstraints`, which is what the browser draws
 *     into the track. Requested rather than commanded: a display source has its
 *     own idea of how large it is and constraints can only ask for less.
 *   - the encoding, through the sender's parameters, which is what is actually
 *     sent. This is the half that decides whether anybody sees the difference —
 *     a capture at 4K published with a 1080p bitrate ceiling is a blurry 4K.
 *
 * Returns whether the encoding was reached. A false means the capture may have
 * changed while what goes out did not, which is worth saying rather than
 * swallowing: it is the difference between "this did nothing" and "this did
 * half of what it said".
 */
export async function retune(
	room: Room,
	frameRate: ShareFrameRate,
	quality: ShareQuality,
): Promise<boolean> {
	const publication = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
	const track = publication?.videoTrack;

	if (!track) return false;

	const profile = settingsFor(frameRate, quality);

	// A hint about what the pixels are, which the encoder uses to decide between
	// holding the picture still and holding the motion smooth. Set before the
	// constraints so a frame captured during the change is already labelled.
	track.mediaStreamTrack.contentHint = profile.contentHint;

	try {
		await track.mediaStreamTrack.applyConstraints({
			width: profile.width,
			height: profile.height,
			frameRate: profile.frameRate,
		});
	} catch {
		// A source that will not narrow. The encoding below is still worth
		// setting: sending fewer frames of a picture the browser insists on
		// capturing at its own size is most of what was asked for.
	}

	const sender = track.sender;
	if (!sender) return false;

	const parameters = sender.getParameters();

	if (!parameters.encodings?.length) return false;

	for (const encoding of parameters.encodings) {
		encoding.maxBitrate = profile.maxBitrate;
		encoding.maxFramerate = profile.frameRate;
	}

	// What to give up when the connection cannot carry all of it. The whole
	// point of choosing a size is that it is not the thing quietly given away,
	// so anything but automatic holds the resolution and drops frames instead.
	parameters.degradationPreference = profile.degradationPreference;

	try {
		await sender.setParameters(parameters);
		return true;
	} catch {
		return false;
	}
}
