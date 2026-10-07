import {
	type AudioCaptureOptions,
	LocalAudioTrack,
	type LocalTrackPublication,
	type Room,
	Track,
	type TrackPublishOptions,
} from "livekit-client";
import { keep, recall } from "@/lib/storage";
import { LOSSLESS, decodedToInt24, toInt24 } from "./lossless";
import { LosslessSender, canSendLossless } from "./lossless-sender";

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

/**
 * Sound shared on its own, sent in real time: Opus at its ceiling.
 *
 * 510 kbit/s is the most a 20 ms Opus frame can hold, and the point of sharing
 * sound by itself is to hear it as well as it can be heard live. RED is off
 * here, not by preference. Measured against this server: at 510 kbit/s with
 * RED, each packet carries two 1275-byte frames, the media server's 1500-byte
 * packet buffer drops every one of them, and the listener receives nothing at
 * all. And from about 250 kbit/s up the browser quietly leaves the redundant
 * copy out anyway -- 256 and 320 went out at exactly their own rate -- so RED
 * protects nothing at these rates and only threatens the whole stream.
 *
 * What protects this sound against loss is the lossless stream beside it,
 * which is the default; this track is what plays where that one cannot.
 */
export const LISTENING_BITRATE = 510_000;

export const LISTENING_PUBLISH: TrackPublishOptions = {
	audioPreset: { maxBitrate: LISTENING_BITRATE },
	forceStereo: true,
	dtx: false,
	red: false,
};

/** The trackName that marks sound shared on its own, without a picture. */
export const LISTENING = "listening";

/** Whether a publication is sound shared on its own, in either form. */
export function soundOnly(publication: { source: Track.Source; trackName: string }): boolean {
	return (
		publication.source === Track.Source.ScreenShareAudio &&
		(publication.trackName === LISTENING || publication.trackName === LOSSLESS)
	);
}

const LOSSLESS_KEY = "meet-live.lossless";

/** Whether this browser last chose to share sound losslessly. On unless turned off. */
export function rememberedLossless(): boolean {
	return recall(LOSSLESS_KEY) !== "off";
}

export function rememberLossless(on: boolean): void {
	keep(LOSSLESS_KEY, on ? undefined : "off");
}

/**
 * Whether sound can be shared losslessly from here, and if not, why.
 *
 * Not in an encrypted call: the stream is data, which the SDK does not encrypt
 * with the options this project gives it, and it would cross the relay as
 * plain samples. See lossless-receiver.ts. And not where the browser cannot
 * read samples off a track, which today means anything but Chromium.
 */
export function losslessUnavailable(room: Room): "encrypted" | "browser" | undefined {
	if (room.options.e2ee !== undefined) return "encrypted";
	if (!canSendLossless()) return "browser";
	return undefined;
}

/** The lossless stream going out of a room, if one is. */
const senders = new WeakMap<Room, LosslessSender>();

/** Whether the sound being shared from here is going out losslessly. */
export function sendingLossless(room: Room): boolean {
	return senders.has(room);
}

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
export async function startListening(
	room: Room,
	lossless = rememberedLossless(),
	onLosslessGaveUp: () => void = () => {},
): Promise<LocalTrackPublication> {
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

	const publication = await publishSound(room, sound, lossless, onLosslessGaveUp);

	// Ended from outside -- the browser's own "stop sharing" bar, or the
	// application being closed -- is the same as ended from here.
	sound.addEventListener("ended", () => void stopListening(room), { once: true });
	picture?.addEventListener("ended", () => void stopListening(room), { once: true });

	return publication;
}

/**
 * Publish a track of sound as sound shared on its own: Opus at its ceiling for
 * everybody, and the lossless stream beside it for whoever asks, where lossless
 * was wanted and can be had. Shared by an application's captured sound and a
 * track played from the music library, which differ only in where the samples
 * come from.
 */
async function publishSound(
	room: Room,
	sound: MediaStreamTrack,
	lossless: boolean,
	onLosslessGaveUp: () => void,
	toInt: (sample: number) => number = toInt24,
): Promise<LocalTrackPublication> {
	const offered = lossless && losslessUnavailable(room) === undefined;

	// Listening for asks before the track that invites them exists. The other
	// way round, a listener who saw the publication at once asked before
	// anything here was listening, and the ask was lost: found in two browsers,
	// where the first ask arrived in the gap and the listener gave up waiting.
	if (offered) {
		senders.set(
			room,
			new LosslessSender(
				room,
				sound,
				() => {
					senders.delete(room);
					onLosslessGaveUp();
				},
				toInt,
			),
		);
	}

	const track = new LocalAudioTrack(sound, MUSIC_CAPTURE, true);
	let publication: LocalTrackPublication;
	try {
		publication = await room.localParticipant.publishTrack(track, {
			...LISTENING_PUBLISH,
			source: Track.Source.ScreenShareAudio,
			name: offered ? LOSSLESS : LISTENING,
		});
	} catch (err) {
		senders.get(room)?.stop();
		senders.delete(room);
		throw err;
	}

	return publication;
}

/** What a library track playing into a room is, for the panel to show. */
export interface NowPlaying {
	title: string;
	artists: string;
	/** What is being played, as read off the file: "FLAC · 24-bit · 44.1 kHz". */
	quality: string;
}

/**
 * The output a room's library tracks play through: one audio context at one
 * rate, one published track, and the node playing now.
 *
 * Kept across tracks. A track that follows at the same rate and bit depth plays
 * on through the same published track, so everybody listening hears the next
 * song without the stream starting again; one that differs closes it and opens
 * another, because a context plays at one rate -- anything else would be
 * resampled -- and the lossless sender turns floats into samples by the bit
 * depth it was opened for (see decodedToInt24).
 */
interface Output {
	context: AudioContext;
	out: MediaStreamAudioDestinationNode;
	/** This machine's own speakers, behind their own volume. */
	monitor: GainNode;
	rate: number;
	bits: number;
	node?: AudioBufferSourceNode;
	now?: NowPlaying;
}

const outputs = new WeakMap<Room, Output>();
/** A track still being fetched, so stopping or choosing another can abandon it. */
const loading = new WeakMap<Room, AbortController>();
const playing = new Set<() => void>();

function changed(): void {
	for (const listener of playing) listener();
}

/** Be told when what the library is playing changes. */
export function subscribePlaying(listener: () => void): () => void {
	playing.add(listener);
	return () => playing.delete(listener);
}

/** What the library is playing into a room, if anything. */
export function nowPlaying(room: Room): NowPlaying | undefined {
	return outputs.get(room)?.now;
}

const MONITOR_KEY = "meet-live.music-monitor";

/**
 * How loud a track playing from here is in this machine's own speakers.
 *
 * Only there. What is sent is untouched by it -- the published track takes the
 * decoded samples before this gain -- so turning one's own speakers down to talk
 * over the music changes nothing anybody else hears, and the lossless stream
 * stays the file.
 */
export function monitorVolume(): number {
	const kept = Number(recall(MONITOR_KEY));
	return Number.isFinite(kept) && kept >= 0 && kept <= 1 && recall(MONITOR_KEY) !== undefined ? kept : 1;
}

export function setMonitorVolume(room: Room, volume: number): void {
	const level = Math.max(0, Math.min(1, volume));
	keep(MONITOR_KEY, level === 1 ? undefined : String(level));
	const output = outputs.get(room);
	if (output) output.monitor.gain.value = level;
	changed();
}

/** What a library track is, to fetch and play it. */
export interface LibraryAudio {
	url: string;
	/** Samples a second the file has; nought where the library could not tell. */
	rate: number;
	format?: string;
	bits?: number;
	now?: NowPlaying;
}

/** A library track fetched and decoded, ready to play. */
export interface Decoded {
	buffer: AudioBuffer;
	rate: number;
	/** The bit depth the lossless sender recovers integers by: 16, or nought for anything else. */
	bits: number;
	now?: NowPlaying;
}

/**
 * Fetch and decode a library track, at its own sample rate.
 *
 * Decoded by an offline context made at the file's rate, because decodeAudioData
 * resamples to its context's rate and to nothing else: a context at the file's
 * rate is the one that hands over the samples the file holds. Separate from
 * playing, so the next track can be fetched while this one plays.
 */
export async function fetchLibraryTrack(
	audio: LibraryAudio,
	signal: AbortSignal,
	onProgress: (fraction: number) => void = () => {},
): Promise<Decoded> {
	const file = await download(audio.url, signal, onProgress);
	const rate = audio.rate > 0 ? audio.rate : 48_000;
	const buffer = await new OfflineAudioContext(2, 1, rate).decodeAudioData(file);
	if (signal.aborted) throw new DOMException("abandoned", "AbortError");

	return { buffer, rate: buffer.sampleRate, bits: audio.format === "flac" && audio.bits === 16 ? 16 : 0, now: audio.now };
}

/**
 * Play a decoded library track into the call, as sound shared on its own.
 *
 * On through the output already open where the rate and bit depth match, so
 * the stream does not start again between songs; otherwise whatever was being
 * shared is stopped and an output opened for this track. The decoded track goes
 * two ways: to a track published exactly as a shared application's sound is,
 * and to this machine's speakers through the monitor's volume.
 *
 * `onEnded` is told when the track finishes, for whatever plays next; without
 * one, the share stops with the track.
 */
export async function playDecoded(
	room: Room,
	decoded: Decoded,
	lossless = rememberedLossless(),
	onLosslessGaveUp: () => void = () => {},
	onEnded?: () => void,
): Promise<void> {
	let output = outputs.get(room);

	if (!output || output.rate !== decoded.rate || output.bits !== decoded.bits) {
		await stopListening(room);

		const context = new AudioContext({ sampleRate: decoded.rate, latencyHint: "playback" });
		const out = context.createMediaStreamDestination();
		out.channelCount = 2;
		out.channelCountMode = "explicit";
		const monitor = context.createGain();
		monitor.gain.value = monitorVolume();
		monitor.connect(context.destination);

		output = { context, out, monitor, rate: decoded.rate, bits: decoded.bits };
		try {
			await context.resume();
			const sound = out.stream.getAudioTracks()[0];
			if (!sound) throw new NoSound();

			outputs.set(room, output);
			// A 16-bit FLAC's own integers are recovered from what the browser
			// decoded; see decodedToInt24. Anything else was never integers.
			await publishSound(room, sound, lossless, onLosslessGaveUp, decodedToInt24(decoded.bits));
		} catch (err) {
			if (outputs.get(room) === output) outputs.delete(room);
			void context.close().catch(() => {});
			changed();
			throw err;
		}
	}

	const previous = output.node;
	const node = output.context.createBufferSource();
	node.buffer = decoded.buffer;
	node.connect(output.out);
	node.connect(output.monitor);

	const current = output;
	node.addEventListener(
		"ended",
		() => {
			// Only the node still playing speaks for the output: one that was
			// replaced, or stopped by stopListening, ends too.
			if (current.node !== node) return;
			if (onEnded) onEnded();
			else void stopListening(room);
		},
		{ once: true },
	);

	output.node = node;
	output.now = decoded.now;
	node.start();
	if (previous) {
		try {
			previous.stop();
		} catch {
			// Already finished.
		}
	}
	changed();
}

/**
 * Fetch, decode and play one library track: what pressing a track does when
 * nothing is queued. The share stops when it ends.
 */
export async function playLibraryTrack(
	room: Room,
	audio: LibraryAudio,
	lossless = rememberedLossless(),
	onLosslessGaveUp: () => void = () => {},
	onProgress: (fraction: number) => void = () => {},
	onEnded?: () => void,
): Promise<void> {
	loading.get(room)?.abort();
	const abort = new AbortController();
	loading.set(room, abort);

	try {
		const decoded = await fetchLibraryTrack(audio, abort.signal, onProgress);
		await playDecoded(room, decoded, lossless, onLosslessGaveUp, onEnded);
	} finally {
		if (loading.get(room) === abort) loading.delete(room);
	}
}

/** Fetch a whole file, saying how far it has got where the length is known. */
async function download(url: string, signal: AbortSignal, onProgress: (fraction: number) => void): Promise<ArrayBuffer> {
	const response = await fetch(url, { credentials: "same-origin", signal });
	if (!response.ok || !response.body) throw new Error(`the track answered ${response.status}`);

	const total = Number(response.headers.get("Content-Length")) || 0;
	const reader = response.body.getReader();
	const parts: Uint8Array[] = [];
	let received = 0;

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value);
		received += value.length;
		if (total) onProgress(Math.min(1, received / total));
	}

	const whole = new Uint8Array(received);
	let at = 0;
	for (const part of parts) {
		whole.set(part, at);
		at += part.length;
	}
	return whole.buffer;
}

/** Whether what is being shared from here is a track from the library. */
export function playingLibrary(room: Room): boolean {
	return outputs.has(room);
}

/** The sound being shared on its own, if any. */
export function listening(room: Room): LocalTrackPublication | undefined {
	for (const publication of room.localParticipant.trackPublications.values()) {
		if (soundOnly(publication)) return publication;
	}

	return undefined;
}

/** Stop sharing sound on its own. Safe to call when nothing is being shared. */
export async function stopListening(room: Room): Promise<void> {
	const publication = listening(room);
	const picture = pictures.get(room);
	pictures.delete(room);
	picture?.stop();
	senders.get(room)?.stop();
	senders.delete(room);

	loading.get(room)?.abort();
	loading.delete(room);

	const output = outputs.get(room);
	outputs.delete(room);
	if (output) {
		const node = output.node;
		output.node = undefined;
		changed();
		try {
			node?.stop();
		} catch {
			// Already finished: the track ended, which is what called this.
		}
		void output.context.close().catch(() => {});
	}

	if (publication?.track) {
		await room.localParticipant.unpublishTrack(publication.track, true);
	}
}
