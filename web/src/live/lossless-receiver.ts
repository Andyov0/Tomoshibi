import { type RemoteParticipant, type Room, RoomEvent, Track } from "livekit-client";
import { settingFor, silenced, subscribe as onHearing } from "./hearing";
import { ASK_EVERY, ASK_TOPIC, LOSSLESS, Malformed, TOPIC, fromInt24, unpack } from "./lossless";
import type { Counts } from "./playout";

/**
 * Hearing somebody's shared sound without loss.
 *
 * For each person whose sound share is offered losslessly (its Opus track is
 * named LOSSLESS), this browser asks for the stream, plays it through its own
 * audio context, and holds the Opus track back at the media server so the same
 * song is not downloaded twice or heard twice a second apart. holdsBack is how
 * the code that applies volumes and blocks (Audible.tsx) learns which Opus
 * tracks to leave off.
 *
 * It is lossless or it is nothing. A stream that has not started STALL_MS after
 * asking, has stopped for that long, or has a packet missing from its sequence
 * is given up on for the rest of that share, and the Opus track comes back. A
 * missing packet should not happen -- the channel is reliable and the media
 * server, as this deployment configures it, never drops from it -- but if one
 * does, twenty milliseconds of the song have gone, and carrying on would be
 * presenting a stream with a hole in it as the lossless one.
 *
 * Not offered in an encrypted call. The SDK encrypts media tracks there and,
 * with the options this project uses, not data packets, so the lossless stream
 * would cross the relay as plain samples in a call whose whole promise is that
 * the relay cannot hear it. The sharer's side never offers it in one either;
 * this side checks as well, because it is the side whose sound it would be.
 */

/** Seconds held before playing: enough for a retransmission across a border. */
const TARGET_SECONDS = 0.6;

/** Past this, whole packets are dropped back to the target. See playout.ts. */
const CEILING_SECONDS = 3;

/** Silence after asking, or between packets, that counts as the stream having failed. */
export const STALL_MS = 4000;

/**
 * How often to ask until the first packet comes.
 *
 * Far more often than the keep-alive, because an unanswered first ask is the
 * likeliest failure there is: it can cross the publication on the way and
 * arrive before the sender is listening, and waiting the full ASK_EVERY to
 * repeat it would outlast STALL_MS and give up on a stream that was fine.
 */
const ASK_UNTIL_ANSWERED = 1000;

/** What plays a stream. A seam for the tests, which have no audio thread. */
export interface Player {
	push(block: Float32Array[]): void;
	volume(level: number): void;
	close(): void;
	counts(): Counts | undefined;
	/** Whether it could not start: no worklet, or none that would load. */
	broken(): boolean;
}

export type MakePlayer = (rate: number, channels: number) => Player;

interface Source {
	/** The publication this is about. A new share is a new publication and a fresh start. */
	publication: string;
	wanted: boolean;
	failed: boolean;
	askedAt: number;
	lastAsk: number;
	lastPacket: number;
	stream?: number;
	nextSeq?: number;
	player?: Player;
}

const sources = new WeakMap<Room, Map<string, Source>>();

/** Whether this person's Opus sound track should be held back, because the lossless one is playing. */
export function holdsBack(room: Room, identity: string): boolean {
	return sources.get(room)?.get(identity)?.wanted === true;
}

/** How a person's lossless stream is doing, if one is being played. For the panel and the tests. */
export function losslessCounts(room: Room, identity: string): Counts | undefined {
	return sources.get(room)?.get(identity)?.player?.counts();
}

/** Whether this browser can play a lossless stream at all. */
export function canReceiveLossless(): boolean {
	return typeof AudioWorkletNode === "function" && typeof AudioContext === "function";
}

function losslessShare(participant: RemoteParticipant) {
	for (const publication of participant.trackPublications.values()) {
		if (publication.source === Track.Source.ScreenShareAudio && publication.trackName === LOSSLESS) {
			return publication;
		}
	}

	return undefined;
}

/**
 * Start listening for lossless shares in a room. Returns the function that stops.
 *
 * `changed` is called whenever which Opus tracks to hold back has changed.
 */
export function receiveLossless(room: Room, changed: () => void, makePlayer: MakePlayer = audioPlayer): () => void {
	const mine = new Map<string, Source>();
	sources.set(room, mine);

	if (!canReceiveLossless() || room.options.e2ee !== undefined) {
		return () => sources.delete(room);
	}

	const ask = (identity: string, yes: boolean) => {
		room.localParticipant
			.publishData(new TextEncoder().encode(yes ? "1" : "0"), {
				reliable: true,
				topic: ASK_TOPIC,
				destinationIdentities: [identity],
			})
			.catch(() => {});
	};

	const giveUp = (identity: string, source: Source) => {
		source.failed = true;
		source.player?.close();
		source.player = undefined;
		ask(identity, false);
	};

	const refresh = () => {
		const now = Date.now();
		let moved = false;

		for (const participant of room.remoteParticipants.values()) {
			const identity = participant.identity;
			const share = losslessShare(participant);
			let source = mine.get(identity);

			if (!share) {
				if (source) {
					source.player?.close();
					mine.delete(identity);
					moved ||= source.wanted;
				}
				continue;
			}

			if (!source || source.publication !== share.trackSid) {
				source?.player?.close();
				source = { publication: share.trackSid, wanted: false, failed: false, askedAt: 0, lastAsk: 0, lastPacket: 0 };
				mine.set(identity, source);
			}

			const setting = settingFor(identity, "screen");
			let want = !source.failed && !silenced(setting);

			// Packets arriving for a player that cannot play is the same failure
			// as packets not arriving, and must come back to Opus just as surely:
			// otherwise the Opus track stays held back and nothing is heard.
			const stalled = now - Math.max(source.askedAt, source.lastPacket) > STALL_MS;
			if (want && source.wanted && (stalled || source.player?.broken())) {
				giveUp(identity, source);
				want = false;
			} else if (want && !source.wanted) {
				source.askedAt = now;
				source.lastAsk = now;
				ask(identity, true);
			} else if (want && now - source.lastAsk >= (source.lastPacket ? ASK_EVERY : ASK_UNTIL_ANSWERED)) {
				source.lastAsk = now;
				ask(identity, true);
			} else if (!want && source.wanted && !source.failed) {
				source.player?.close();
				source.player = undefined;
				source.stream = undefined;
				ask(identity, false);
			}

			if (want !== source.wanted) {
				source.wanted = want;
				moved = true;
			}

			source.player?.volume(setting.volume);
		}

		for (const [identity, source] of mine) {
			if (!room.remoteParticipants.has(identity)) {
				source.player?.close();
				mine.delete(identity);
				moved ||= source.wanted;
			}
		}

		if (moved) changed();
	};

	const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
		if (topic !== TOPIC || !participant) return;

		const source = mine.get(participant.identity);
		if (!source?.wanted) return;

		let block: ReturnType<typeof unpack>;
		try {
			block = unpack(payload);
		} catch (err) {
			if (err instanceof Malformed) return;
			throw err;
		}

		if (block.stream !== source.stream) {
			source.player?.close();
			source.player = makePlayer(block.rate, block.channels.length);
			source.player.volume(settingFor(participant.identity, "screen").volume);
			source.stream = block.stream;
			source.nextSeq = block.seq;
		}

		if (block.seq !== source.nextSeq) {
			giveUp(participant.identity, source);
			refresh();
			return;
		}

		source.nextSeq = block.seq + 1;
		source.lastPacket = Date.now();
		source.player?.push(block.channels.map((channel) => Float32Array.from(channel, fromInt24)));
	};

	const events = [
		RoomEvent.TrackPublished,
		RoomEvent.TrackUnpublished,
		RoomEvent.ParticipantConnected,
		RoomEvent.ParticipantDisconnected,
	] as const;

	for (const event of events) room.on(event, refresh);
	room.on(RoomEvent.DataReceived, onData);
	const unhear = onHearing(refresh);
	const timer = setInterval(refresh, 1000);
	refresh();

	return () => {
		clearInterval(timer);
		unhear();
		for (const event of events) room.off(event, refresh);
		room.off(RoomEvent.DataReceived, onData);
		for (const [identity, source] of mine) {
			source.player?.close();
			if (source.wanted) ask(identity, false);
		}
		mine.clear();
		sources.delete(room);
	};
}

/** The real player: its own audio context at the stream's rate, and the worklet. */
function audioPlayer(rate: number, channels: number): Player {
	// At the stream's own rate, so nothing between the packet and the sound
	// card resamples it. Whatever the operating system does after that is the
	// same for every sound on the machine.
	const context = new AudioContext({ sampleRate: rate, latencyHint: "playback" });
	const gain = context.createGain();
	gain.connect(context.destination);

	let node: AudioWorkletNode | undefined;
	let latest: Counts | undefined;
	let early: Float32Array[][] = [];
	let closed = false;
	let broken = false;

	const post = (block: Float32Array[]) => {
		node?.port.postMessage(
			block,
			block.map((channel) => channel.buffer),
		);
	};

	// A context made outside a gesture can start suspended; the next press
	// anywhere on the page is enough to start it.
	const resume = () => {
		if (context.state === "suspended") void context.resume();
	};
	if (context.state === "suspended") {
		document.addEventListener("pointerdown", resume, { once: true });
		document.addEventListener("keydown", resume, { once: true });
	}

	void (async () => {
		const { default: url } = await import("./playout.worklet.ts?worker&url");
		await context.audioWorklet.addModule(url);
		if (closed) return;

		node = new AudioWorkletNode(context, "tomoshibi-lossless", {
			numberOfInputs: 0,
			numberOfOutputs: 1,
			outputChannelCount: [2],
			processorOptions: {
				channels,
				target: Math.round(TARGET_SECONDS * rate),
				ceiling: Math.round(CEILING_SECONDS * rate),
			},
		});
		node.port.onmessage = (event: MessageEvent<Counts>) => {
			latest = event.data;
		};
		node.connect(gain);

		for (const block of early) post(block);
		early = [];
	})().catch(() => {
		broken = true;
	});

	return {
		push(block) {
			if (node) post(block);
			else early.push(block);
		},
		volume(level) {
			gain.gain.value = level;
		},
		close() {
			closed = true;
			document.removeEventListener("pointerdown", resume);
			document.removeEventListener("keydown", resume);
			void context.close().catch(() => {});
		},
		counts: () => latest,
		broken: () => broken,
	};
}
