import {
	type AudioCaptureOptions,
	LocalAudioTrack,
	type LocalTrackPublication,
	type Room,
	Track,
	type TrackPublishOptions,
} from "livekit-client";
import { keep, recall } from "@/lib/storage";

/**
 * How sound is captured and sent: a voice, a voice with nothing done to it, and
 * music.
 *
 * Nothing about sound was set anywhere before this, so every call ran on the
 * SDK's defaults, and those are tuned for a phone call on a bad line rather than
 * for people who can hear the difference. A microphone went out at 48 kbit/s
 * mono with DTX, which stops sending in a pause and so clips the first syllable
 * after one; the browser was asked for automatic gain, noise suppression and
 * voice isolation, each of which reshapes a voice before it is encoded; and the
 * sound of a shared screen went out the same way as a voice, folded to mono,
 * gated and run through the same processing. Music came out of that as a
 * telephone recording of a radio.
 *
 * Three profiles now, chosen by what is being sent rather than by a single
 * default that has to be wrong for two of them.
 */

/**
 * A voice, as it is sent by default.
 *
 * 64 kbit/s is where Opus stops being the thing anybody notices about a voice,
 * and RED -- each packet carrying the one before it -- is kept, because the
 * losses it repairs are the cross-border ones this deployment exists to
 * survive. DTX is off: it saved upload in silences and spent it on the clipped
 * starts of every sentence, and the upload a voice costs is small beside the
 * picture sent with it.
 */
export const VOICE_BITRATE = 64_000;

/**
 * A voice with nothing done to it, for somebody wearing headphones, singing, or
 * playing an instrument into the microphone. Noise suppression treats a held
 * note as noise and automatic gain rides a crescendo down; both are off, and
 * the bitrate is raised because there is now more to carry.
 *
 * Echo cancellation stays on even here. Without it, anybody on speakers sends
 * the room back to itself, and the person who switched this on is not the one
 * who would hear the result.
 */
export const ORIGINAL_BITRATE = 96_000;

/**
 * Music and the sound of a shared screen: stereo, untouched, and enough bits to
 * carry both channels -- 160 kbit/s is transparent for stereo Opus, and RED
 * doubles it on the wire, which is still less than the smallest picture a share
 * sends. DTX and RED are named rather than left to the SDK, which turns both
 * off for any stereo track it is not told about; DTX stays off because a pause
 * in music is part of it, and RED is kept for the same reason as on a voice.
 */
export const MUSIC_BITRATE = 160_000;

/** The trackName that marks sound shared on its own, without a picture. */
export const LISTENING = "listening";

const ORIGINAL_KEY = "meet-live.original-sound";

/** Whether this browser was last told to send the voice as it is. */
export function rememberedOriginal(): boolean {
	return recall(ORIGINAL_KEY) === "on";
}

function rememberOriginal(on: boolean): void {
	keep(ORIGINAL_KEY, on ? "on" : undefined);
}

/**
 * What the browser is asked for when it opens the microphone.
 *
 * `voiceIsolation` is asked to be off, not left out. The SDK's own default asks
 * for it, and where a browser honours it the voice is rebuilt by a model that
 * is very good at removing a keyboard and noticeably bad at leaving a voice
 * sounding like itself.
 */
export function voiceCapture(original: boolean): AudioCaptureOptions {
	return {
		echoCancellation: true,
		noiseSuppression: !original,
		autoGainControl: !original,
		voiceIsolation: false,
		channelCount: 1,
	};
}

/** How a microphone is published. */
export function voicePublish(original: boolean): TrackPublishOptions {
	return {
		audioPreset: { maxBitrate: original ? ORIGINAL_BITRATE : VOICE_BITRATE },
		dtx: false,
		red: true,
	};
}

/**
 * What the browser is asked for when it captures a screen's or an app's sound.
 *
 * Everything that improves a voice damages music, so all of it is off, and two
 * channels are asked for. `restrictOwnAudio` keeps this tab's own output -- the
 * call itself -- out of a capture that would otherwise include it, which is
 * what sharing the whole system's sound does: everybody would hear themselves
 * come back a second later. Browsers that do not know the name ignore it.
 */
export const MUSIC_CAPTURE: MediaTrackConstraints = {
	echoCancellation: false,
	noiseSuppression: false,
	autoGainControl: false,
	channelCount: 2,
	sampleRate: 48_000,
	...({ restrictOwnAudio: true, suppressLocalAudioPlayback: false } as MediaTrackConstraints),
};

/** How music and a shared screen's sound are published. */
export const MUSIC_PUBLISH: TrackPublishOptions = {
	audioPreset: { maxBitrate: MUSIC_BITRATE },
	forceStereo: true,
	dtx: false,
	red: true,
};

/**
 * Switch a voice between processed and as it is, and remember the choice.
 *
 * Applied to the microphone already published as well as to the next one: the
 * capture is restarted with the new constraints on the same device, and the
 * sender's bitrate is changed in place. Republishing would also work and would
 * drop the voice for a moment in front of everybody, which is the opposite of
 * what somebody adjusting their sound wants.
 *
 * The room's own defaults are changed too, because they are what the SDK reads
 * when the microphone is next turned on from off.
 */
export async function applyOriginalSound(room: Room, on: boolean): Promise<void> {
	rememberOriginal(on);
	room.options.audioCaptureDefaults = { ...room.options.audioCaptureDefaults, ...voiceCapture(on) };
	room.options.publishDefaults = { ...room.options.publishDefaults, ...voicePublish(on) };

	const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
	if (!(track instanceof LocalAudioTrack)) return;

	const device = track.mediaStreamTrack.getSettings().deviceId;
	await track.restartTrack({
		...voiceCapture(on),
		...(device ? { deviceId: { exact: device } } : {}),
	});

	const sender = track.sender;
	if (!sender) return;
	const parameters = sender.getParameters();
	const [encoding] = parameters.encodings ?? [];
	if (!encoding) return;
	encoding.maxBitrate = on ? ORIGINAL_BITRATE : VOICE_BITRATE;
	await sender.setParameters(parameters);
}

/** Thrown when a picker was answered but the browser handed back no sound. */
export class NoSound extends Error {
	constructor() {
		super("no sound was shared");
		this.name = "NoSound";
	}
}

/**
 * The picture a sound-only share was captured with, kept so it can be stopped
 * with the sound.
 *
 * Kept rather than stopped at once. Every browser requires a picture with a
 * display capture, and the sound is the only part wanted; stopping the picture
 * the moment it arrives is the usual trick, but whether the capture as a whole
 * survives that is the browser's decision and has differed between versions.
 * Disabled and unpublished, it costs nothing but the browser's indicator, which
 * is shown either way.
 */
const pictures = new WeakMap<Room, MediaStreamTrack>();

/**
 * Share one application's sound, or a tab's, or the whole system's, without a
 * picture -- to listen to something together.
 *
 * `windowAudio: "window"` is the part that makes it one application: from
 * Chrome 141 a picked window is offered with "share this app's audio too", and
 * what is captured is that application's sound alone, before it is mixed with
 * anything else on the machine and before the speakers. That is also why it is
 * better than playing music into a microphone, which hears the room. Where the
 * browser does not offer it, a tab still can, and the whole screen can on
 * systems that capture system audio; the person is told when what they chose
 * came with no sound rather than being left to wonder why nobody hears it.
 *
 * The SDK's screen-share path cannot do this: it builds the options for
 * getDisplayMedia from a fixed list of fields, and `windowAudio` is not among
 * them.
 */
export async function startListening(room: Room): Promise<LocalTrackPublication> {
	const stream = await navigator.mediaDevices.getDisplayMedia({
		video: { width: { max: 640 }, height: { max: 360 }, frameRate: { max: 1 } },
		audio: MUSIC_CAPTURE,
		...({
			windowAudio: "window",
			systemAudio: "include",
			selfBrowserSurface: "exclude",
			surfaceSwitching: "include",
		} as DisplayMediaStreamOptions),
	});

	const [sound] = stream.getAudioTracks();
	const [picture] = stream.getVideoTracks();

	if (!sound) {
		for (const track of stream.getTracks()) track.stop();
		throw new NoSound();
	}

	if (picture) {
		picture.enabled = false;
		pictures.set(room, picture);
	}

	const track = new LocalAudioTrack(sound, MUSIC_CAPTURE, true);
	const publication = await room.localParticipant.publishTrack(track, {
		...MUSIC_PUBLISH,
		source: Track.Source.ScreenShareAudio,
		name: LISTENING,
	});

	// Ended from outside -- the browser's own "stop sharing" bar, or the
	// application being closed -- is the same as ended from here.
	sound.addEventListener("ended", () => void stopListening(room), { once: true });
	picture?.addEventListener("ended", () => void stopListening(room), { once: true });

	return publication;
}

/** The sound being shared on its own, if any. */
export function listening(room: Room): LocalTrackPublication | undefined {
	for (const publication of room.localParticipant.trackPublications.values()) {
		if (publication.source === Track.Source.ScreenShareAudio && publication.trackName === LISTENING) {
			return publication;
		}
	}

	return undefined;
}

/** Stop sharing sound on its own. Safe to call when nothing is being shared. */
export async function stopListening(room: Room): Promise<void> {
	const publication = listening(room);
	const picture = pictures.get(room);
	pictures.delete(room);
	picture?.stop();

	if (publication?.track) {
		await room.localParticipant.unpublishTrack(publication.track, true);
	}
}
