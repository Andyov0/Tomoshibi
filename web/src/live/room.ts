import {
	type LocalTrackPublication,
	type Participant,
	Room,
	RoomEvent,
	Track,
	type VideoCodec,
	VideoPreset,
	VideoPresets,
} from "livekit-client";
import type { Join } from "./api";
import { installNoValidate } from "./novalidate";
import { seal, sealing } from "./secrecy";

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
 * A ceiling of 1440p at sixty, which is what most people get, because most
 * people never open this menu.
 *
 * It was 1080p at thirty, and both halves cost the person who never chose. The
 * size is a ceiling rather than a target, so a 1080p display was already
 * captured at its own size — but a 1440p or 4K display, which is most desks
 * now, had its screen reduced to 1080p before encoding and its text softened
 * for nothing. And thirty frames is visibly less smooth on anything that
 * scrolls or plays, for want of a setting nobody knew to change.
 *
 * It no longer gives ground either: like every other setting it holds the
 * picture and lets the frames bend, and it publishes one encode. The old
 * distinction — automatic adapts, named sizes do not — is gone, because
 * adapting meant quietly handing somebody a smaller picture than the one they
 * are trying to read.
 *
 * What is left of it is only this: automatic is a ceiling that suits any
 * display, and the named sizes are for somebody who has decided.
 */
const AUTOMATIC = { width: 2560, height: 1440, frameRate: 60 as ShareFrameRate };

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
const BITS_PER_PIXEL_PER_FRAME = 0.22;
const BITRATE_CAP = 80_000_000;
const BITRATE_FLOOR = 8_000_000;

/**
 * The frame rate the cost is measured against.
 *
 * Thirty, because that is what a screen share was before anybody offered more,
 * and so it is the rate the pixels-per-frame figure was chosen to be right at.
 */
const BASE_RATE = 30;

/**
 * The smaller copies of a share, beneath the one that was chosen.
 *
 * A share used to be published as a single encode, and the argument for that
 * was wrong in a way worth writing down, because it reads as sound and is not.
 * It said that simulcast divides the allowance between the layers, so a smaller
 * copy would be paid for out of the picture everybody is looking at. It does
 * not: `encodingsFromPresets` in the SDK hands the top layer the encoding it
 * was given and gives each smaller layer the bitrate its own preset names.
 *
 * What the single encode produced is the fault this exists for. A media server
 * holding one layer has two moves for a subscriber who cannot take it — forward
 * it anyway, or pause the track — and both are a black rectangle. Measured on a
 * live call: a room held a long way from half the people in it, the leg out of
 * it carrying two megabits a second with a tenth of the packets lost, and a
 * share asking thirty-eight. The share did not soften. It disappeared, while the
 * audio went on perfectly, which is why it was reported as the sharing being
 * broken rather than as a slow network.
 *
 * ## Why two, and why these sizes
 *
 * The first attempt was one layer at 960x540, chosen for legibility on a
 * starved path without asking what else selects a layer. Two things do, and the
 * other one is the tile.
 *
 * A subscriber's client reports the size of the element the share is drawn
 * into, and the server takes `requestedSize = height * 0.9` and then the
 * smallest layer at least that tall (livekit-server mediatrackreceiver.go:1113,
 * layerSelectionTolerance at :43). A 540-line layer is therefore selected for
 * any element between about 400 and 640 device pixels tall — a 1366x768 laptop
 * with the window maximised, and a phone held sideways. Those people were being
 * handed fifteen frames a second and 800 kb/s of a screen they had both the
 * bandwidth and the pixels to read properly, and nothing said so.
 *
 * So the ladder is built around what a tile will ask for rather than around one
 * number:
 *
 *   - 640x360 sits below every real stage, so nothing but a genuinely tiny
 *     element selects it by size. It is what congestion control falls to, and
 *     that is the only way anybody ordinarily reaches it.
 *   - 1280x720 is the honest answer for a small window: more than such an
 *     element can draw, at about a tenth of the top layer's cost.
 *
 * ## What they cost the person sharing
 *
 * Nothing, until somebody needs one. `dynacast` is on, and a simulcast layer no
 * subscriber has asked for is paused at the publisher rather than encoded and
 * thrown away. That is the whole reason the ladder can be this generous without
 * spending an upstream that, on the connections this has to work on, is the
 * scarcest thing in the call: a room where everybody is watching at full size
 * sends exactly one encode, the same as before any of this existed.
 *
 * The sizes are absolute rather than relative — `scaleResolutionDownBy` is
 * worked out from the capture's smaller dimension — so these come out 640x360
 * and 1280x720 whether the screen behind them is 1080p, 1440p or 4K.
 */
export const SMALL = new VideoPreset(640, 360, 500_000, 15);
export const MIDDLE = new VideoPreset(1280, 720, 2_500_000, 30);

/**
 * What goes beneath the top layer, smallest first — the order the SDK sorts
 * presets into, and therefore the order the encodings come back in.
 */
export const BENEATH = [SMALL, MIDDLE];

/**
 * What to ask for, given a size and a rate.
 *
 * The rate counts for far less than the size, and the first version had them
 * counting the same. Multiplying by frames a second assumes each frame costs
 * what the first one did, which is true of a camera pointed at a room and
 * emphatically false of a screen: at a hundred and twenty frames a second, one
 * frame differs from the last by a moved cursor and a line of text, and a codec
 * spends almost nothing on it.
 *
 * So the rate enters under a square root — doubling it costs about forty per
 * cent more rather than twice as much, which is roughly what encoders actually
 * do with this material. Linear, the high settings asked for forty-four and
 * fifty megabits a second, which no ordinary path carries: the estimator finds
 * out, clamps hard, and the encoder answers by dropping frames. That arrives as
 * a share that stutters while the throughput reading looks entirely healthy,
 * which is exactly the complaint this is here to answer.
 */
function bitrateFor(width: number, height: number, frameRate: number): number {
	const perFrame = width * height * BITS_PER_PIXEL_PER_FRAME;
	const wanted = perFrame * BASE_RATE * Math.sqrt(frameRate / BASE_RATE);

	return Math.round(Math.min(BITRATE_CAP, Math.max(BITRATE_FLOOR, wanted)));
}

/**
 * What to send, given both choices.
 *
 * H.264 throughout. It has hardware encoding on essentially every machine, and
 * above 1080p or above thirty frames the alternative is not a softer picture
 * but an encoder falling behind — which arrives as a share that stutters and
 * drifts, and never announces itself.
 *
 * VP8 used to be kept for 1080p at fifteen or thirty, because it honours the
 * `text` content hint and a hardware H.264 encoder tuned for faces makes small
 * type the first thing to go soft. It is not any more, and this paragraph said
 * it still was for long enough to be worth correcting rather than deleting: a
 * comment describing a branch that is not there sends the next reader looking
 * for it.
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
			// Nothing gives up the picture, here or anywhere else. A share is
			// read rather than watched: a frame that arrives late is late, and
			// a line of type scaled to two thirds of its size is unreadable and
			// nobody at the other end can undo it.
			degradationPreference: "maintain-resolution" as RTCDegradationPreference,
			adapts: false,
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
		// H.264 throughout, including the still picture that used to take VP8.
		//
		// VP8 renders text a little more crisply — it has no chroma subsampling
		// to soften coloured letters — and it is software on essentially every
		// machine, both to encode and to decode. A share is the one track in a
		// call that everybody is looking at, so that softness is paid for by one
		// person's processor and the sharpness is spent on everybody else's.
		videoCodec: "h264" as VideoCodec,
		contentHint: (still ? "text" : "motion") as "text" | "motion" | "detail",
		/*
		 * What gives, where something must: frames, never the picture.
		 *
		 * This used to turn on the rate — the picture held below thirty frames
		 * and given away above it, on the reasoning that somebody who asked for a
		 * high rate asked for the frames. That is right about a camera and wrong
		 * about a screen. What is on a shared screen is text, code and diagrams,
		 * and the two failures are not comparable: a late frame is late, and type
		 * that has been scaled away is gone.
		 */
		degradationPreference: "maintain-resolution" as RTCDegradationPreference,
		adapts: false,
	};
}

/**
 * Whether this is a device that runs on a battery and draws its pictures small.
 *
 * Asked of the pointer rather than of the user agent string. What matters is
 * whether there is a mouse — a machine somebody points at with a finger is a
 * machine with a small screen, a modest encoder and a battery, and all three
 * want the same answer. The user agent would name the operating system, which is
 * a different question with a well-known history of wrong answers.
 */
function handheld(): boolean {
	return (
		typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches
	);
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
/**
 * A room, ready to connect.
 *
 * `secret` is required rather than defaulted, and empty is how a call says it
 * is not sealed. A default would make forgetting to pass it compile — and what
 * forgetting produces is a call somebody was told is encrypted and is not,
 * which is the one failure here that must not be quiet.
 */
export function create(secret: string): Room {
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
			// Smaller on a hand-held, and not as a concession to the network.
			//
			// A phone in a nine-up grid is drawn at a couple of hundred points
			// however large it was captured, so the pixels above that are encoded,
			// sent and thrown away — on the one device paying for all three out of
			// a battery. The camera on the front of a phone is also rarely worth
			// 720 lines of anybody's attention.
			resolution: handheld() ? VideoPresets.h360.resolution : VideoPresets.h720.resolution,
		},
		publishDefaults: {
			/*
			 * H.264, which is the one codec every machine encodes and decodes in
			 * hardware.
			 *
			 * This was VP9, for its layering: one stream carrying three spatial
			 * and three temporal layers, so a tile in a nine-up grid is served
			 * something sized for a nine-up grid. That is the better shape and it
			 * is paid for in silicon nobody has — VP9 encode is software almost
			 * everywhere, and VP9 decode is software on a great many phones. In a
			 * call of six, every participant was software-decoding five streams.
			 *
			 * Simulcast gets the same result the older way: three encodes instead
			 * of one layered stream, each of them on hardware. More upstream
			 * bandwidth from whoever is publishing, and far less work everywhere —
			 * which is the trade worth making on the devices that struggle, and
			 * they are the only ones where any of this is noticeable.
			 */
			videoCodec: "h264",
			simulcast: true,

			/*
			 * No second encode in another codec.
			 *
			 * The SDK's default is `backupCodec: true`, which on an unsealed call
			 * means this: the moment one subscriber turns up whose browser cannot
			 * decode H.264, the media server asks for VP8 and the publisher
			 * starts a *whole second encode of the same picture* — at the same
			 * maxBitrate and maxFramerate it was already sending, with simulcast
			 * forced off, in software. One person joining roughly doubles what
			 * the person sharing has to upload, and nothing anywhere says so.
			 *
			 * That is the one cost this deployment cannot pay. The connections
			 * that matter here are the constrained ones; they are the scarce
			 * thing in every call, and the whole point of the layer ladder above
			 * is that the distribution burden sits on the server rather than on
			 * them.
			 *
			 * What it costs to turn off: a browser with no H.264 at all sees no
			 * video from this publisher. Every current browser has it, on every
			 * platform this is used from, and the ones that do not would be
			 * paying for it out of somebody else's upload rather than their own.
			 */
			backupCodec: false,
		},
		// Speaking is worked out by the media server and pushed to everybody, so
		// no client has to run an analyser of its own.
		disconnectOnPageLeave: true,

		// Media the relay cannot read, where somebody asked for it and the
		// browser can do it. Undefined otherwise, and a room built without it is
		// the room this always built.
		//
		// Given to the constructor rather than turned on afterwards, because the
		// SDK builds its transports around it: a room that starts unencrypted
		// cannot become encrypted without reconnecting, and half a call is not a
		// state worth being able to reach.
		e2ee: sealing(secret),
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

export async function connect(room: Room, grant: Join, secret: string): Promise<void> {
	tokens.set(room, grant.token);

	// The key before the connection, and encryption on before anything is
	// published.
	//
	// Before, because a track published while this is still off goes out in
	// clear and the machines carrying it have already seen it — turning it on a
	// moment later does not take that back. Nothing here is published until
	// after connect returns, so this is the last moment that is still early
	// enough.
	if (secret && sealing(secret)) {
		await seal(grant.room, secret);
		await room.setE2EEEnabled(true);
	}

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
			/*
			 * The capture, in the one shape the SDK will pass on.
			 *
			 * This has been wrong twice, in opposite directions, and both times
			 * the symptom was the same: every share came out at thirty frames a
			 * second whatever the menu said, and nothing anywhere reported it.
			 *
			 * The first version wrote media constraints into `resolution` —
			 * `{ width: { max: 1920 } }` — so that the size would be a ceiling,
			 * with a cast to make it compile. `resolution` is a VideoResolution,
			 * three plain numbers, and the SDK gates the whole block on
			 * `resolution.width > 0`. An object is not greater than zero, so
			 * every constraint was dropped and the browser was asked for
			 * `video: true`.
			 *
			 * The second version moved them to `video`, which is passed through
			 * untouched — and that is worse, because of this, in
			 * createLocalScreenTracks:
			 *
			 *     if (options.resolution === undefined && !isSafari17Based())
			 *       options.resolution = ScreenSharePresets.h1080fps30.resolution
			 *
			 * Leaving `resolution` out does not mean "no resolution". It means
			 * 1920x1080 at thirty, which is then written over the `video`
			 * constraints by the Object.assign below it. Omitting the field is
			 * how a browser is asked for thirty frames on purpose.
			 *
			 * So: the SDK's own shape, always present, with the numbers this file
			 * chose. The rate arrives intact, which is the whole point.
			 *
			 * What is given up is the size as a ceiling. The SDK writes
			 * `width: { ideal }` for everything but Safari 17, ideal is a target,
			 * and there is no way to say ceiling through a field that is three
			 * numbers. So somebody on a 1080p display who picks 1440p has their
			 * screen scaled up before it is encoded — more pixels carrying
			 * nothing, at the same bitrate ceiling, so it costs processor and not
			 * upload.
			 *
			 * That was clamped for a while, to `screen.width` — and the clamp was
			 * worse than the thing it fixed. `screen` describes the display the
			 * browser window is on, not the surface the picker returns, so
			 * somebody with a laptop and a 4K monitor who chose 4K and shared the
			 * monitor was given 1080p of it. Losing a picture the person asked
			 * for is a worse trade than spending some of their processor on one
			 * they did not, and it was invisible from both ends. `settle` below
			 * takes the other half of the problem: the ceiling follows the
			 * picture that actually arrived.
			 *
			 * The rate is the clamped one, not what was asked for — a rate
			 * remembered from a size that allowed it would otherwise reach a
			 * capture that cannot do it, and the browser answers by giving
			 * whatever it likes rather than by saying no.
			 */
			resolution: {
				width: profile.width,
				height: profile.height,
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

			// The whole allowance in the top layer, and a ladder beneath it.
			//
			// Nothing above is reduced by this: the layer everybody able to take
			// it receives is exactly the one `screenShareEncoding` asks for, and
			// dynacast pauses the rungs nobody has asked for. What they change is
			// the answer given to somebody who cannot take the top one — which
			// was nothing at all. See SMALL and MIDDLE for the measurement that
			// prompted them and for why the SDK's own default layer is neither.
			simulcast: true,
			screenShareSimulcastLayers: BENEATH,
		},
	);

	/*
	 * Nothing below this narrows what was just asked for.
	 *
	 * There was a follower. It read the sender's statistics every four seconds
	 * and halved its own ceiling whenever it judged the share to be struggling,
	 * down to a floor of 1.2 Mb/s — a fifth of what an ordinary share asks —
	 * and wrote that number to local storage, where it became the opening
	 * ceiling for every later share on every later network, climbing back at an
	 * eighth per twelve seconds. Two things were wrong with it, and both were
	 * silent. It read a low frame count as evidence of trouble, and a screen
	 * that is not changing sends almost no frames by design, so a still screen
	 * with a handful of retransmissions was indistinguishable from a congested
	 * one. And nothing ever expired what it remembered, so one bad afternoon
	 * set the ceiling for good.
	 *
	 * It is gone rather than mended. The browser runs a congestion controller
	 * of its own that measures the path continuously and is not working from
	 * four-second summaries; a second one layered on top of it could only ever
	 * subtract. What the path will carry is the browser's question. What the
	 * share is worth is this file's, and it is answered upward.
	 *
	 * `settle` below is not that, and the difference is worth being precise
	 * about: it never reads the network. It asks the capture what size it turned
	 * out to be and makes the ceiling match, which is the same arithmetic
	 * bitrateFor already does — done once, against the picture that arrived
	 * rather than the one that was requested.
	 */

	await settle(published, profile);

	return published;
}

/**
 * Make the ceiling match the picture that actually arrived.
 *
 * What a share is worth is worked out from the size that was chosen, and the
 * size that was chosen is a request. A window is smaller than a screen; a
 * display is whatever it is; and `width: { ideal }` is a target the browser is
 * free to miss in either direction. So the number reaching the encoder was
 * computed for a picture nobody was necessarily sending — generous where the
 * capture came back small, which is upload spent on nothing, and that upload is
 * the scarcest thing in these calls.
 *
 * Only downward, and only the top layer. Raising it would be this file arguing
 * with the setting somebody chose, and the rungs below already follow the
 * capture through `scaleResolutionDownBy`.
 *
 * Failures are swallowed. A ceiling that is too generous is what this deployment
 * had for its whole life; a share that will not start because a parameter write
 * was refused is worse than one that costs a little too much.
 */
async function settle(
	published: LocalTrackPublication | undefined,
	profile: ReturnType<typeof settingsFor>,
): Promise<void> {
	const sender = published?.videoTrack?.sender;
	const track = published?.videoTrack?.mediaStreamTrack;

	if (!sender || !track) return;

	const { width, height } = track.getSettings();
	if (!width || !height) return;

	// The same picture, or a larger one than was asked for. Nothing to give back.
	if (width * height >= profile.width * profile.height) return;

	const worth = bitrateFor(width, height, profile.frameRate);
	if (worth >= profile.maxBitrate) return;

	try {
		const parameters = sender.getParameters();
		const top = parameters.encodings?.[parameters.encodings.length - 1];

		if (!top) return;

		top.maxBitrate = worth;
		await sender.setParameters(parameters);
	} catch {
		// See above: too generous is the state this shipped in for months.
	}
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

	// Sixty rather than thirty: this is what somebody gets who picks a size and
	// never touches the rate, and thirty is visibly less smooth on anything
	// that scrolls or plays.
	return 60;
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
		// The same shape the capture was asked for, and for the same reason: a
		// plain number is a target, so adjusting to 1440p on a 1080p display
		// would have the browser scale the screen up rather than leave it alone.
		// These were plain numbers while the capture used `resolution`, so the
		// two halves of one setting disagreed about what a size means.
		await track.mediaStreamTrack.applyConstraints({
			width: { max: profile.width },
			height: { max: profile.height },
			frameRate: { ideal: profile.frameRate },
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

	/*
	 * The top layer takes the new setting; the small copy keeps being small.
	 *
	 * This loop used to give every encoding the profile's bitrate and rate,
	 * which was right while a share was one encode and became silently
	 * destructive the moment it stopped being one: the fallback would be handed
	 * the top layer's ceiling and stop being a fallback, so somebody nudging the
	 * frame rate mid-share would double their upstream and take away the only
	 * thing a starved subscriber could still receive. Nothing would have said
	 * so — the picture at the sending end is identical either way.
	 *
	 * The last encoding is the top one: presets are sorted ascending and
	 * encodingsFromPresets emits them in that order.
	 */
	const top = parameters.encodings.length - 1;

	// The capture as it is now, after the constraints above, because that is
	// what every smaller layer is scaled against.
	const settled = track.mediaStreamTrack.getSettings();
	const shortest = Math.min(settled.width ?? profile.width, settled.height ?? profile.height);

	parameters.encodings.forEach((encoding, index) => {
		if (index === top) {
			encoding.maxBitrate = profile.maxBitrate;
			encoding.maxFramerate = profile.frameRate;
			return;
		}

		// Its own rung, not one number for all of them.
		const beneath = BENEATH[index] ?? SMALL;

		encoding.maxBitrate = beneath.encoding.maxBitrate;
		encoding.maxFramerate = beneath.encoding.maxFramerate;

		// And the size, which nothing here used to touch. The SDK works
		// scaleResolutionDownBy out once, at publish, against the capture as it
		// was then; a share resized afterwards left every smaller layer scaled
		// by a ratio taken against a picture that no longer exists, so the
		// ladder quietly stopped being the sizes it is named for.
		encoding.scaleResolutionDownBy = Math.max(1, shortest / beneath.height);
	});

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
