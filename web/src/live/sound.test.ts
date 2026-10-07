import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "livekit-client";
import { LOSSLESS } from "./lossless";
import {
	LISTENING,
	LISTENING_BITRATE,
	MUSIC_CAPTURE,
	NoSound,
	ORIGINAL_BITRATE,
	VOICE_BITRATE,
	listening,
	nowPlaying,
	playLibraryTrack,
	sendingLossless,
	startListening,
	subscribePlaying,
	stopListening,
	voiceCapture,
	voicePublish,
} from "./sound";

/*
 * How sound is captured and sent.
 *
 * Every one of these failed silently before it was set: a call ran on the SDK's
 * defaults, and the only symptom was that it sounded worse than it should, which
 * nobody files as a bug. So the settings are asserted where they are made, and
 * sharing sound on its own is driven through a picker that can be told what to
 * hand back -- including nothing, which is what a browser does when the sound
 * box was left unticked.
 */

vi.mock("livekit-client", async (original) => {
	const real = await original<typeof import("livekit-client")>();

	// A track around a fake MediaStreamTrack; the real one wants a browser.
	class LocalAudioTrack {
		constructor(
			public mediaStreamTrack: MediaStreamTrack,
			public constraints?: MediaTrackConstraints,
		) {}
	}

	return { ...real, LocalAudioTrack };
});

describe("a voice", () => {
	it("is processed by default, without voice isolation", () => {
		expect(voiceCapture(false)).toMatchObject({
			echoCancellation: true,
			noiseSuppression: true,
			autoGainControl: true,
			voiceIsolation: false,
		});
	});

	it("is left alone in original sound, except for echo cancellation", () => {
		expect(voiceCapture(true)).toMatchObject({
			echoCancellation: true,
			noiseSuppression: false,
			autoGainControl: false,
			voiceIsolation: false,
		});
	});

	it("is sent continuously, with redundancy, at more than the SDK's default", () => {
		expect(voicePublish(false)).toEqual({ audioPreset: { maxBitrate: VOICE_BITRATE }, dtx: false, red: true });
		expect(voicePublish(true).audioPreset).toEqual({ maxBitrate: ORIGINAL_BITRATE });
		expect(VOICE_BITRATE).toBeGreaterThan(48_000);
	});
});

function fakeTrack(kind: "audio" | "video") {
	return { kind, enabled: true, stop: vi.fn(), addEventListener: vi.fn() } as unknown as MediaStreamTrack & {
		stop: ReturnType<typeof vi.fn>;
	};
}

function fakeRoom(options: Record<string, unknown> = {}) {
	const publications = new Map<string, unknown>();
	const publishTrack = vi.fn(async (track: unknown, options: { source: string; name: string }) => {
		const publication = { source: options.source, trackName: options.name, track };
		publications.set("one", publication);
		return publication;
	});
	const unpublishTrack = vi.fn(async () => {
		publications.clear();
	});
	const room = {
		options,
		localParticipant: { trackPublications: publications, publishTrack, unpublishTrack },
		remoteParticipants: new Map(),
		on: vi.fn(),
		off: vi.fn(),
	};

	return { room: room as unknown as Room, publishTrack, unpublishTrack };
}

describe("sharing sound on its own", () => {
	const getDisplayMedia = vi.fn();

	beforeEach(() => {
		Object.defineProperty(navigator, "mediaDevices", {
			value: { getDisplayMedia },
			configurable: true,
		});
	});

	afterEach(() => {
		getDisplayMedia.mockReset();
	});

	it("asks for one application's sound, untouched and in stereo", async () => {
		const sound = fakeTrack("audio");
		const picture = fakeTrack("video");
		getDisplayMedia.mockResolvedValue({
			getAudioTracks: () => [sound],
			getVideoTracks: () => [picture],
			getTracks: () => [sound, picture],
		});
		const { room } = fakeRoom();

		await startListening(room);

		const asked = getDisplayMedia.mock.calls[0]?.[0];
		expect(asked.windowAudio).toBe("window");
		expect(asked.audio).toEqual(MUSIC_CAPTURE);
		expect(asked.audio).toMatchObject({ echoCancellation: false, noiseSuppression: false, channelCount: 2 });
	});

	it("publishes it at Opus's ceiling, without the RED that would sink it", async () => {
		const sound = fakeTrack("audio");
		getDisplayMedia.mockResolvedValue({
			getAudioTracks: () => [sound],
			getVideoTracks: () => [],
			getTracks: () => [sound],
		});
		const { room, publishTrack } = fakeRoom();

		await startListening(room, false);

		const options = publishTrack.mock.calls[0]?.[1];
		expect(options).toMatchObject({
			source: "screen_share_audio",
			name: LISTENING,
			forceStereo: true,
			dtx: false,
			red: false,
			audioPreset: { maxBitrate: LISTENING_BITRATE },
		});
		expect(LISTENING_BITRATE).toBe(510_000);
		expect(listening(room)).toBeDefined();
		expect(sendingLossless(room)).toBe(false);
	});

	describe("losslessly", () => {
		// Reads nothing: these tests are about what is offered, not what is sent.
		class Processor {
			readable = new ReadableStream({ start() {} });
		}

		beforeEach(() => {
			vi.stubGlobal("MediaStreamTrackProcessor", Processor);
		});

		afterEach(() => {
			vi.unstubAllGlobals();
			Object.defineProperty(navigator, "mediaDevices", { value: { getDisplayMedia }, configurable: true });
		});

		const sharing = () => {
			const sound = fakeTrack("audio");
			getDisplayMedia.mockResolvedValue({
				getAudioTracks: () => [sound],
				getVideoTracks: () => [],
				getTracks: () => [sound],
			});
		};

		it("offers the lossless stream under its own name, and sends it", async () => {
			sharing();
			const { room, publishTrack } = fakeRoom();

			await startListening(room, true);

			expect(publishTrack.mock.calls[0]?.[1]).toMatchObject({ name: LOSSLESS });
			expect(listening(room)).toBeDefined();
			expect(sendingLossless(room)).toBe(true);

			await stopListening(room);
			expect(sendingLossless(room)).toBe(false);
		});

		it("never offers it in an encrypted call, where it would cross the relay in the clear", async () => {
			sharing();
			const { room, publishTrack } = fakeRoom({ e2ee: { keyProvider: {}, worker: {} } });

			await startListening(room, true);

			expect(publishTrack.mock.calls[0]?.[1]).toMatchObject({ name: LISTENING });
			expect(sendingLossless(room)).toBe(false);
		});

		it("does not offer it where the browser cannot read samples off a track", async () => {
			vi.unstubAllGlobals();
			sharing();
			const { room, publishTrack } = fakeRoom();

			await startListening(room, true);

			expect(publishTrack.mock.calls[0]?.[1]).toMatchObject({ name: LISTENING });
			expect(sendingLossless(room)).toBe(false);
		});
	});

	it("keeps the picture it had to take, switched off, and stops it with the sound", async () => {
		const sound = fakeTrack("audio");
		const picture = fakeTrack("video");
		getDisplayMedia.mockResolvedValue({
			getAudioTracks: () => [sound],
			getVideoTracks: () => [picture],
			getTracks: () => [sound, picture],
		});
		const { room, unpublishTrack } = fakeRoom();

		await startListening(room);
		expect(picture.enabled).toBe(false);
		expect(picture.stop).not.toHaveBeenCalled();

		await stopListening(room);
		expect(unpublishTrack).toHaveBeenCalledTimes(1);
		expect(picture.stop).toHaveBeenCalledTimes(1);
		expect(listening(room)).toBeUndefined();
	});

	it("says so when the choice came back with no sound, and lets the capture go", async () => {
		const picture = fakeTrack("video");
		getDisplayMedia.mockResolvedValue({
			getAudioTracks: () => [],
			getVideoTracks: () => [picture],
			getTracks: () => [picture],
		});
		const { room, publishTrack } = fakeRoom();

		await expect(startListening(room)).rejects.toBeInstanceOf(NoSound);
		expect(picture.stop).toHaveBeenCalledTimes(1);
		expect(publishTrack).not.toHaveBeenCalled();
	});
});

describe("sharing sound losslessly, in order", () => {
	it("is listening for asks before the publication that invites them exists", async () => {
		const sound = { kind: "audio", enabled: true, stop: vi.fn(), addEventListener: vi.fn() };
		Object.defineProperty(navigator, "mediaDevices", {
			value: {
				getDisplayMedia: vi.fn(async () => ({
					getAudioTracks: () => [sound],
					getVideoTracks: () => [],
					getTracks: () => [sound],
				})),
			},
			configurable: true,
		});
		vi.stubGlobal("MediaStreamTrackProcessor", class {
			readable = new ReadableStream({ start() {} });
		});

		const order: string[] = [];
		const room = {
			options: {},
			remoteParticipants: new Map(),
			on: vi.fn((event: string) => order.push(`on:${event}`)),
			off: vi.fn(),
			localParticipant: {
				trackPublications: new Map(),
				publishTrack: vi.fn(async () => {
					order.push("publish");
					return {};
				}),
			},
		} as unknown as Room;

		await startListening(room, true);

		expect(order.indexOf("on:dataReceived")).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("on:dataReceived")).toBeLessThan(order.indexOf("publish"));
		await stopListening(room);
		vi.unstubAllGlobals();
	});
});

describe("playing a track from the library", () => {
	function stubAudio() {
		const contexts: { options: AudioContextOptions; closed: boolean }[] = [];
		const nodes: { started: boolean; stopped: boolean; listeners: Record<string, () => void> }[] = [];
		const fetched: string[] = [];
		const destinationTrack = fakeTrack("audio");

		class FakeContext {
			record: { options: AudioContextOptions; closed: boolean };
			destination = {};
			constructor(options: AudioContextOptions) {
				this.record = { options, closed: false };
				contexts.push(this.record);
			}
			async resume() {}
			async close() {
				this.record.closed = true;
			}
			async decodeAudioData(data: ArrayBuffer) {
				return { decodedFrom: data.byteLength };
			}
			createBufferSource() {
				const record = { started: false, stopped: false, listeners: {} as Record<string, () => void> };
				nodes.push(record);
				return {
					buffer: null,
					connect: vi.fn(),
					start: () => {
						record.started = true;
					},
					stop: () => {
						record.stopped = true;
					},
					addEventListener: (name: string, listener: () => void) => {
						record.listeners[name] = listener;
					},
				};
			}
			createMediaStreamDestination() {
				return { stream: { getAudioTracks: () => [destinationTrack] }, channelCount: 0, channelCountMode: "" };
			}
		}

		vi.stubGlobal("AudioContext", FakeContext);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				fetched.push(url);
				return new Response(new Uint8Array(1000), { headers: { "Content-Length": "1000" } });
			}),
		);
		vi.stubGlobal("MediaStreamTrackProcessor", class {
			readable = new ReadableStream({ start() {} });
		});

		return { contexts, nodes, fetched, destinationTrack };
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("decodes at the track's own rate, so nothing resamples it, and shares it losslessly", async () => {
		const { contexts, nodes, fetched, destinationTrack } = stubAudio();
		const { room, publishTrack } = fakeRoom();
		const progress = vi.fn();

		await playLibraryTrack(
			room,
			{ url: "/api/music/audio?x", rate: 44_100, now: { title: "t", artists: "a", quality: "q" } },
			true,
			() => {},
			progress,
		);

		expect(contexts[0]?.options.sampleRate).toBe(44_100);
		expect(fetched).toEqual(["/api/music/audio?x"]);
		expect(progress).toHaveBeenLastCalledWith(1);
		expect(nodes[0]?.started).toBe(true);
		expect(publishTrack.mock.calls[0]?.[1]).toMatchObject({ name: LOSSLESS, source: "screen_share_audio" });
		expect((publishTrack.mock.calls[0]?.[0] as { mediaStreamTrack: unknown }).mediaStreamTrack).toBe(destinationTrack);
		expect(nowPlaying(room)?.title).toBe("t");
		expect(sendingLossless(room)).toBe(true);
	});

	it("stops playing, lets the context go and says nothing is playing when stopped", async () => {
		const { contexts, nodes } = stubAudio();
		const { room } = fakeRoom();
		const told = vi.fn();
		const unsubscribe = subscribePlaying(told);

		await playLibraryTrack(room, { url: "/u", rate: 48_000 }, true);
		await stopListening(room);

		expect(nodes[0]?.stopped).toBe(true);
		expect(contexts[0]?.closed).toBe(true);
		expect(nowPlaying(room)).toBeUndefined();
		expect(sendingLossless(room)).toBe(false);
		expect(told).toHaveBeenCalled();
		unsubscribe();
	});

	it("stops by itself when the track ends", async () => {
		const { nodes } = stubAudio();
		const { room, unpublishTrack } = fakeRoom();

		await playLibraryTrack(room, { url: "/u", rate: 44_100 }, false);
		nodes[0]?.listeners.ended?.();
		await Promise.resolve();
		await Promise.resolve();

		expect(unpublishTrack).toHaveBeenCalled();
		expect(nowPlaying(room)).toBeUndefined();
	});
});
