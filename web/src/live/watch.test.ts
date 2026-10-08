import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "livekit-client";
import {
	CLOSE_ENOUGH,
	FAST_NUDGE,
	NUDGE,
	SEEK_AT,
	SETTLED,
	STARTING_MS,
	type Show,
	TOPIC,
	Theatre,
	type TheatreDeps,
	closeTheatre,
	command,
	correction,
	expected,
	STALE_MS,
	TELL_STILL,
	hearShows,
	readShow,
	seenShow,
	startTheatre,
} from "./watch";
import type { Resolved } from "./watch-api";

/*
Watching together.

What would go wrong quietly: a pause from somebody who is not running the show
undone by the show's next word; a late, older message putting everybody back
where they were; a viewer chasing the show forever in small jumps; a link that
failed for somebody else reported to nobody; a show everybody still believes in
after the person running it has gone; and anything at all said in an encrypted
call.
*/

type Handler = (...args: unknown[]) => void;

function fakeRoom(identity = "gholder-1", others: string[] = ["gfriend-2"], options: Record<string, unknown> = {}) {
	const handlers = new Map<string, Set<Handler>>();
	const sent: { message: Record<string, unknown>; to?: string[] }[] = [];
	const remoteParticipants = new Map(others.map((id) => [id, { identity: id, name: id.toUpperCase() }]));

	const room = {
		options,
		remoteParticipants,
		localParticipant: {
			identity,
			name: "Holder",
			publishData: vi.fn(async (bytes: Uint8Array, opts: { destinationIdentities?: string[] }) => {
				sent.push({ message: JSON.parse(new TextDecoder().decode(bytes)), to: opts.destinationIdentities });
			}),
		},
		on(event: string, handler: Handler) {
			if (!handlers.has(event)) handlers.set(event, new Set());
			handlers.get(event)?.add(handler);
		},
		off(event: string, handler: Handler) {
			handlers.get(event)?.delete(handler);
		},
	};

	const emit = (event: string, ...args: unknown[]) => {
		for (const handler of handlers.get(event) ?? []) handler(...args);
	};
	const send = (identity: string, message: unknown) =>
		emit("dataReceived", new TextEncoder().encode(JSON.stringify(message)), remoteParticipants.get(identity), 0, TOPIC);

	return { room: room as unknown as Room, sent, emit, send, remoteParticipants };
}

const ticketOf = (title: string) => `ticket-${title}`.padEnd(22, "x");

const resolved = (title: string, duration = 100): Resolved => ({
	ticket: ticketOf(title),
	title,
	duration,
	cover: "",
	link: `https://example.invalid/${title}`,
	live: false,
	relay: false,
	play: { kind: "file", url: `https://example.invalid/${title}.mp4` },
	proxy: { kind: "file", url: "/api/watch/media?t=x.y" },
});

function fakeDeps() {
	const deps: TheatreDeps = {
		resolve: vi.fn(async (text: string) => (text.includes("bad") ? ("not_a_video" as const) : resolved(text.split("/").at(-1) ?? text))),
		onRefused: vi.fn(),
	};
	return deps;
}

/** A theatre whose first video has started: added, and playable at the holder. */
async function playing(theatre: Theatre, title = "one") {
	await theatre.add(`https://example.invalid/${title}`, "Holder");
	theatre.ready(theatre.state().now?.key ?? "");
}

const settle = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

let clock = 0;
beforeEach(() => {
	clock = 1000;
	vi.spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("the show", () => {
	it("plays the first video added and queues the rest, and moves on when one ends", async () => {
		const { room } = fakeRoom();
		const theatre = new Theatre(room, fakeDeps());

		await playing(theatre);
		await theatre.add("https://example.invalid/two", "Holder");

		expect(theatre.state()).toMatchObject({ playing: true, position: 0 });
		expect(theatre.state().now?.ticket).toBe(ticketOf("one"));
		expect(theatre.state().queue.map((one) => one.ticket)).toEqual([ticketOf("two")]);

		theatre.ended("not-this-one");
		expect(theatre.state().now?.ticket).toBe(ticketOf("one"));
		theatre.ended(theatre.state().now?.key ?? "");
		expect(theatre.state().now?.ticket).toBe(ticketOf("two"));
		theatre.close();
	});

	it("keeps time while playing, holds still while paused, and goes where it is sent", async () => {
		const { room } = fakeRoom();
		const theatre = new Theatre(room, fakeDeps());
		await playing(theatre);

		clock += 10_000;
		expect(theatre.state().position).toBeCloseTo(10);

		theatre.pause();
		clock += 5_000;
		expect(theatre.state()).toMatchObject({ playing: false });
		expect(theatre.state().position).toBeCloseTo(10);

		theatre.seek(42);
		expect(theatre.state().position).toBe(42);
		theatre.seek(1e6);
		expect(theatre.state().position).toBe(100);
		theatre.seek(-5);
		expect(theatre.state().position).toBe(0);
		theatre.close();
	});

	it("waits at the start until the holder can play the video, so everybody begins together", async () => {
		const { room } = fakeRoom();
		const theatre = new Theatre(room, fakeDeps());
		await theatre.add("https://example.invalid/one", "Holder");

		clock += 3000;
		expect(theatre.state()).toMatchObject({ playing: false, position: 0 });

		theatre.ready("some-other-video");
		expect(theatre.state().playing).toBe(false);
		theatre.ready(theatre.state().now?.key ?? "");
		clock += 2000;
		expect(theatre.state()).toMatchObject({ playing: true });
		expect(theatre.state().position).toBeCloseTo(2);
		theatre.close();
	});

	it("starts without the holder's player if it never can play", async () => {
		const { room } = fakeRoom();
		const theatre = new Theatre(room, fakeDeps());
		await theatre.add("https://example.invalid/one", "Holder");

		clock += STARTING_MS + 1000;

		expect(theatre.state().playing).toBe(true);
		expect(theatre.state().position).toBeCloseTo(1);
		theatre.close();
	});

	it("counts every change, so a late message is known to be late", async () => {
		const { room } = fakeRoom();
		const theatre = new Theatre(room, fakeDeps());
		await theatre.add("https://example.invalid/one", "Holder");
		const before = theatre.state().version;

		theatre.pause();
		theatre.play();
		theatre.seek(3);

		expect(theatre.state().version).toBe(before + 3);
		theatre.close();
	});

	it("does as anybody in the call asks, and tells only the asker a link could not be added", async () => {
		const { room, send, sent } = fakeRoom("gholder-1", ["gfriend-2", "gother-3"]);
		const deps = fakeDeps();
		const theatre = new Theatre(room, deps);

		send("gfriend-2", { t: "add", text: "https://example.invalid/one" });
		await settle();
		expect(theatre.state().now).toMatchObject({ ticket: ticketOf("one"), by: "GFRIEND-2" });
		theatre.ready(theatre.state().now?.key ?? "");

		send("gother-3", { t: "pause" });
		expect(theatre.state().playing).toBe(false);
		send("gother-3", { t: "seek", to: 12 });
		expect(theatre.state().position).toBe(12);
		send("gother-3", { t: "play" });
		expect(theatre.state().playing).toBe(true);

		send("gother-3", { t: "add", text: "https://example.invalid/bad" });
		await settle();
		expect(sent.at(-1)).toEqual({ message: { t: "refused", why: "not_a_video" }, to: ["gother-3"] });
		expect(deps.onRefused).not.toHaveBeenCalled();
		theatre.close();
	});

	it("tells whoever runs it, here, when its own link could not be added", async () => {
		const { room } = fakeRoom();
		const deps = fakeDeps();
		const theatre = new Theatre(room, deps);

		await theatre.add("https://example.invalid/bad", "Holder");

		expect(deps.onRefused).toHaveBeenCalledWith("not_a_video", "Holder");
		theatre.close();
	});

	it("says last of all that it closed", async () => {
		const { room, sent } = fakeRoom();
		const theatre = new Theatre(room, fakeDeps());
		await theatre.add("https://example.invalid/one", "Holder");

		theatre.close();
		theatre.play();

		expect(sent.at(-1)?.message).toEqual({ t: "closed" });
	});

	it("is the same object each time it is asked for while still, until something changes", async () => {
		const { room } = fakeRoom();
		const theatre = new Theatre(room, fakeDeps());
		await theatre.add("https://example.invalid/one", "Holder");
		theatre.pause();

		const first = theatre.state();
		expect(theatre.state()).toBe(first);
		theatre.seek(5);
		expect(theatre.state()).not.toBe(first);
		theatre.close();
	});
});

describe("keeping a player to the show", () => {
	it("leaves a player that is close enough alone", () => {
		expect(correction(10 + CLOSE_ENOUGH / 2, 10, true)).toEqual({ rate: 1 });
	});

	it("runs a player that is a little behind a little fast, and one a little ahead a little slow", () => {
		expect(correction(9.7, 10, true)).toEqual({ rate: 1 + NUDGE });
		expect(correction(10.3, 10, true)).toEqual({ rate: 1 - NUDGE });
	});

	it("runs faster to close a gap of a second, which a seek over the internet leaves", () => {
		expect(correction(9, 10, true)).toEqual({ rate: 1 + FAST_NUDGE });
		expect(correction(11, 10, true)).toEqual({ rate: 1 - FAST_NUDGE });
	});

	it("closes a gap it has started on all the way, not just inside the line it started at", () => {
		const between = 10 - (CLOSE_ENOUGH + SETTLED) / 2;
		expect(correction(between, 10, true, 1)).toEqual({ rate: 1 });
		expect(correction(between, 10, true, 1 + NUDGE)).toEqual({ rate: 1 + NUDGE });
		expect(correction(10 - SETTLED / 2, 10, true, 1 + NUDGE)).toEqual({ rate: 1 });
	});

	it("jumps a player that is far out, either way", () => {
		expect(correction(10 - SEEK_AT - 1, 10, true)).toEqual({ seek: 10, rate: 1 });
		expect(correction(10 + SEEK_AT + 1, 10, true)).toEqual({ seek: 10, rate: 1 });
	});

	it("moves a paused player to where the show paused, and runs nothing", () => {
		expect(correction(10.05, 10, false)).toEqual({ rate: 1 });
		expect(correction(10.25, 10, false)).toEqual({ seek: 10, rate: 1 });
	});

	it("reckons where the show is from what was heard and how long ago", () => {
		const show = {
			holder: "h",
			holderName: "",
			queue: [],
			playing: true,
			position: 10,
			version: 1,
			now: { key: "k", by: "b", ticket: ticketOf("x"), duration: 30, live: false },
		};
		expect(expected({ show, at: 1000 }, 6000)).toBe(15);
		expect(expected({ show: { ...show, playing: false }, at: 1000 }, 6000)).toBe(10);
		expect(expected({ show, at: 1000 }, 100_000)).toBe(30);
	});
});

describe("a show heard from elsewhere", () => {
	const state = (version: number, position = 0): Show => ({
		holder: "gholder-2",
		holderName: "",
		queue: [],
		playing: true,
		position,
		version,
		now: { key: "k", by: "b", ticket: ticketOf("x"), duration: 100, live: false },
	});

	it("is believed from whoever runs it, and an older word after a newer one changes nothing", () => {
		const { room, send } = fakeRoom("gme-1", ["gholder-2", "gliar-3"]);
		const stop = hearShows(room);

		send("gliar-3", { t: "state", show: state(9) });
		expect(seenShow(room)).toBeUndefined();

		send("gholder-2", { t: "state", show: state(5, 50) });
		send("gholder-2", { t: "state", show: state(4, 10) });
		expect(seenShow(room)?.show.position).toBe(50);
		stop();
	});

	it("is not believed once whoever runs it closes it or leaves", () => {
		const { room, send, emit, remoteParticipants } = fakeRoom("gme-1", ["gholder-2"]);
		const stop = hearShows(room);

		send("gholder-2", { t: "state", show: state(1) });
		send("gholder-2", { t: "closed" });
		expect(seenShow(room)).toBeUndefined();

		send("gholder-2", { t: "state", show: state(2) });
		remoteParticipants.delete("gholder-2");
		emit("participantDisconnected", { identity: "gholder-2" });
		expect(seenShow(room)).toBeUndefined();
		stop();
	});

	it("is ignored when what arrives is not a show, and stripped of anything a show does not carry", () => {
		const { room, send } = fakeRoom("gme-1", ["gholder-2"]);
		const stop = hearShows(room);

		send("gholder-2", { t: "state", show: { ...state(1), queue: "not a list" } });
		expect(seenShow(room)).toBeUndefined();

		send("gholder-2", { t: "state", show: { ...state(2), now: { ...state(2).now, url: "https://evil.example.invalid/v.mp4" } } });
		expect(seenShow(room)?.show.now).not.toHaveProperty("url");
		stop();
	});

	it("is driven by asking whoever runs it, and nobody else", () => {
		const { room, send, sent } = fakeRoom("gme-1", ["gholder-2", "gother-3"]);
		const stop = hearShows(room);
		send("gholder-2", { t: "state", show: state(1) });

		command(room, { t: "pause" });

		expect(sent.at(-1)).toEqual({ message: { t: "pause" }, to: ["gholder-2"] });
		stop();
	});

	it("hears why a link it sent was refused", () => {
		const { room, send } = fakeRoom("gme-1", ["gholder-2"]);
		const refused = vi.fn();
		const stop = hearShows(room, refused);
		send("gholder-2", { t: "state", show: state(1) });

		send("gholder-2", { t: "refused", why: "unavailable" });

		expect(refused).toHaveBeenCalledWith("unavailable");
		stop();
	});

	it("keeps a second show from being started beside it", () => {
		const { room, send } = fakeRoom("gme-1", ["gholder-2"]);
		const stop = hearShows(room);
		send("gholder-2", { t: "state", show: state(1) });

		expect(startTheatre(room, fakeDeps())).toBeUndefined();
		stop();
	});
});

it("says and hears nothing in an encrypted call", () => {
	const { room, sent, send } = fakeRoom("gme-1", ["gholder-2"], { e2ee: { keyProvider: {} } });

	const stop = hearShows(room);
	send("gholder-2", { t: "state", show: { holder: "gholder-2", holderName: "", queue: [], playing: false, position: 0, version: 1 } });

	expect(startTheatre(room, fakeDeps())).toBeUndefined();
	expect(seenShow(room)).toBeUndefined();
	expect(sent).toEqual([]);
	stop();
});

it("gives its own show the same view until the show changes", async () => {
	const { room } = fakeRoom();
	const theatre = startTheatre(room, fakeDeps());
	await theatre?.add("https://example.invalid/one", "Holder");

	clock += 3000;
	const first = seenShow(room);
	clock += 3000;
	expect(seenShow(room)).toBe(first);

	theatre?.pause();
	expect(seenShow(room)).not.toBe(first);
	closeTheatre(room);
});

describe("what is heard of a show", () => {
	const good = {
		holder: "gholder-2",
		holderName: "H",
		queue: [{ key: "k2", by: "b", ticket: ticketOf("two"), duration: 5, live: false }],
		playing: true,
		position: 3,
		version: 2,
		now: { key: "k1", by: "b", ticket: ticketOf("one"), duration: 9, live: false },
	};

	it("is taken as it is when every field is what it should be", () => {
		expect(readShow(good)).toEqual(good);
	});

	it("is dropped whole when any of it is not, rather than taking a page down", () => {
		for (const bad of [
			{ ...good, queue: "not a list" },
			{ ...good, queue: [{ ...good.queue[0], ticket: "javascript:alert(1)" }] },
			{ ...good, now: { ...good.now, ticket: "https://evil.example.invalid/x.mp4" } },
			{ ...good, position: -1 },
			{ ...good, position: Number.NaN },
			{ ...good, playing: "yes" },
			{ ...good, version: undefined },
			{ ...good, queue: Array.from({ length: 501 }, () => good.queue[0]) },
			null,
			"state",
		]) {
			expect(readShow(bad)).toBeUndefined();
		}
	});

	it("carries no address, title or picture, which come from the server by the ticket", () => {
		const extra = readShow({ ...good, now: { ...good.now, url: "https://evil.example.invalid/v.mp4", title: "x", cover: "https://evil/c.jpg" } });
		expect(extra?.now).toEqual(good.now);
	});
});

it("skips only the video it was asked to skip, so two presses do not skip two", async () => {
	const { room } = fakeRoom();
	const theatre = new Theatre(room, fakeDeps());
	await playing(theatre);
	await theatre.add("https://example.invalid/two", "Holder");
	await theatre.add("https://example.invalid/three", "Holder");
	const first = theatre.state().now?.key ?? "";

	theatre.skip(first);
	theatre.skip(first);

	expect(theatre.state().now?.ticket).toBe(ticketOf("two"));
	theatre.close();
});

it("keeps telling the call it is there while paused, more often than a viewer gives up on it", async () => {
	vi.useFakeTimers();
	const { room, sent } = fakeRoom();
	const theatre = new Theatre(room, fakeDeps());
	await playing(theatre);
	theatre.pause();
	const before = sent.filter((one) => one.message.t === "state").length;

	vi.advanceTimersByTime(STALE_MS);

	const told = sent.filter((one) => one.message.t === "state").length - before;
	expect(told).toBeGreaterThanOrEqual(STALE_MS / TELL_STILL - 1);
	theatre.close();
});

