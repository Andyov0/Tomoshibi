import { type RemoteParticipant, type Room, RoomEvent } from "livekit-client";
import { type Resolved, TICKET, rememberInfo } from "./watch-api";

/**
 * Watching a video together.
 *
 * Modelled on the video players people build into VRChat worlds: somebody
 * pastes a link, everybody plays it in their own browser from wherever it
 * comes from, and what is shared is only which video, how far in, and whether
 * it is playing. Nobody's picture of a film crosses the call, so it arrives at
 * the quality each viewer's own connection can take, and costs the call
 * nothing.
 *
 * One person's browser runs the show -- whoever started it, who must be signed
 * in, because reading a link is done by the deployment on somebody's behalf --
 * and says where it is: on every change, every two seconds while it plays, and
 * whenever somebody arrives and says hello. Everybody may drive it: a link
 * pasted, play, pause, a seek, a skip, all sent to the one running it and
 * applied there, so there is one timeline and not one per person. Each player
 * then keeps to that timeline, nudging its speed to close a small gap and
 * jumping across a large one; see `correction`.
 *
 * There is one timeline and everybody follows it, the one running the show
 * included. The first version told the room where the holder's own player was
 * and had that player follow the timeline, and the two disagreed by however
 * long the video took to load there: measured in two browsers, the holder ran
 * fast to catch a timeline two seconds ahead while everybody else was pulled
 * back to the holder's reports, the two a second apart and closing at a tenth
 * of a second a second. So a video now starts when the holder's player can
 * play it -- or STARTING_MS after it was chosen, if it never can -- and from
 * then on the timeline is the only clock.
 *
 * In an encrypted call it is not offered at all. What everybody is watching is
 * data, which this project's SDK options do not encrypt, and it is not
 * something the relay is to be told in a call whose promise is that it hears
 * nothing.
 */

export const TOPIC = "watch";

/** How often the one running the show says where it is, while it plays. */
export const TELL_EVERY = 2000;

/**
 * And while it is still: paused, waiting, or between videos. Never longer than
 * a third of STALE_MS, or a show paused for a conversation would be taken for
 * one that had ended -- it was, for every viewer, twenty seconds into a pause.
 */
export const TELL_STILL = 5000;

/** Past this, a player jumps to where the show is rather than catching up. */
export const SEEK_AT = 2;
/**
 * A playing player starts closing a gap wider than this, and stops once it is
 * inside SETTLED: two lines rather than one, so a player does not sit just
 * inside a single line for good. Measured with one: after a resume, two
 * browsers stayed 0.22 s apart under a line at 0.25 for as long as they played.
 */
export const CLOSE_ENOUGH = 0.12;
export const SETTLED = 0.04;
/**
 * A paused player further than this from the show is moved to it. Small,
 * because moving a still picture is not seen: at 0.3 two browsers paused by one
 * press sat a quarter of a second apart on different frames.
 */
export const PAUSED_CLOSE_ENOUGH = 0.1;
/** How much faster or slower a player runs to close a small gap. */
export const NUDGE = 0.05;
/**
 * And a larger one, past FAR. A seek on a file fetched over the internet lands
 * about a second after it was asked for, by which time the show has moved on a
 * second: measured with a real video, a viewer arriving late landed a second
 * behind, and at five per cent took twenty seconds to close it.
 */
export const FAR = 0.5;
export const FAST_NUDGE = 0.12;

/** How long a new video waits for the holder's player before its timeline runs anyway. */
export const STARTING_MS = 8000;

/** How long a show that has said nothing is believed to still exist. */
export const STALE_MS = 20_000;

/**
 * One video in the show, as the call knows it: the ticket it plays, who put it
 * there, and the two facts the timeline needs. Everything else -- the title,
 * where it plays from -- each browser asks the server for by the ticket; see
 * videoInfo in watch-api.ts.
 */
export interface Video {
	key: string;
	by: string;
	ticket: string;
	/** Seconds; nought where unknown. */
	duration: number;
	live: boolean;
}

/** What everybody is told. */
export interface Show {
	holder: string;
	holderName: string;
	now?: Video;
	queue: Video[];
	playing: boolean;
	/** Seconds into `now` when this was said. */
	position: number;
	/** Grows with every change, so a message arriving late never undoes a newer one. */
	version: number;
}

/** What anybody may ask of the show. */
export type Command =
	| { t: "add"; text: string }
	| { t: "play" }
	| { t: "pause" }
	| { t: "seek"; to: number }
	/** Past the video named, and only that one: two presses do not skip two. */
	| { t: "skip"; key?: string }
	| { t: "remove"; key: string };

/** Why a link pasted elsewhere was not added: said back to whoever pasted it. */
export type Refusal = "not_a_video" | "unavailable" | "failed";

type Message =
	| { t: "state"; show: Show }
	| { t: "closed" }
	| { t: "hello" }
	| { t: "refused"; why: Refusal }
	| Command;

/** What the show needs from outside; a seam for the tests. */
export interface TheatreDeps {
	resolve: (text: string) => Promise<Resolved | "not_a_video" | "unavailable" | "failed">;
	/** A link that could not be added, and who pasted it. */
	onRefused: (why: "not_a_video" | "unavailable" | "failed", by: string) => void;
}

let counter = 0;
const newKey = () => `${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** The show, as run by whoever started it. */
export class Theatre {
	private now?: Video;
	private queue: Video[] = [];
	private playing = false;
	private position = 0;
	private at = performance.now();
	private version = 0;
	/** A video chosen and not yet playable at the holder: its timeline waits. */
	private starting?: { key: string; since: number };
	private closed = false;
	private listeners = new Set<() => void>();
	private timer?: ReturnType<typeof setInterval>;
	private cached?: Show;

	constructor(
		private readonly room: Room,
		private readonly deps: TheatreDeps,
	) {
		room.on(RoomEvent.DataReceived, this.onData);
		room.on(RoomEvent.ParticipantConnected, this.announce);
		let still = 0;
		this.timer = setInterval(() => {
			still += TELL_EVERY;
			if (this.running() || still >= TELL_STILL) {
				still = 0;
				this.announce();
			}
		}, TELL_EVERY);
		this.announce();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Where the show's timeline is now. */
	current(): number {
		if (!this.now) return 0;
		this.settle();
		const at = this.position + (this.running() ? (performance.now() - this.at) / 1000 : 0);
		return this.now.duration ? Math.min(at, this.now.duration) : at;
	}

	/** Whether the timeline is moving: playing, and not waiting for the video to start. */
	private running(): boolean {
		return this.playing && this.starting === undefined;
	}

	/** Gives up waiting for the holder's player once STARTING_MS has passed. */
	private settle(): void {
		if (this.starting && performance.now() - this.starting.since >= STARTING_MS) {
			// From when the wait ran out, not from whenever this was next asked.
			const ran = this.starting.since + STARTING_MS;
			this.starting = undefined;
			this.at = ran;
			this.changed();
		}
	}

	/** The holder's player can play this video: its timeline starts now, for everybody. */
	ready(key: string): void {
		if (this.starting?.key !== key) return;
		this.starting = undefined;
		this.mark(this.position);
		this.changed();
	}

	state(): Show {
		// Built afresh while playing, because the position moves; kept while
		// still, so asking twice gives the same object.
		if (this.cached && !this.running()) {
			this.settle();
			if (this.cached) return this.cached;
		}
		const show: Show = {
			holder: this.room.localParticipant.identity,
			holderName: this.room.localParticipant.name || "",
			now: this.now,
			queue: [...this.queue],
			// Not yet, while the video is still on its way at the holder:
			// everybody waits at the start and then begins together.
			playing: this.running() && this.now !== undefined,
			position: this.current(),
			version: this.version,
		};
		this.cached = show;
		return show;
	}

	/** Add what a link plays. `from` is whoever pasted it elsewhere, told if it cannot be added. */
	async add(text: string, by: string, from?: string): Promise<boolean> {
		const found = await this.deps.resolve(text.slice(0, 2000));
		if (this.closed) return false;
		if (typeof found === "string") {
			if (from) this.say({ t: "refused", why: found }, [from]);
			else this.deps.onRefused(found, by);
			return false;
		}
		rememberInfo(found);
		this.queue.push({ key: newKey(), by, ticket: found.ticket, duration: found.duration, live: found.live });
		if (!this.now) this.next();
		else this.changed();
		return true;
	}

	play(): void {
		if (!this.now || this.playing) return;
		this.mark(this.current());
		this.playing = true;
		this.changed();
	}

	pause(): void {
		if (!this.now || !this.playing) return;
		this.mark(this.current());
		this.playing = false;
		this.changed();
	}

	seek(to: number): void {
		if (!this.now || !Number.isFinite(to)) return;
		const end = this.now.duration || Number.POSITIVE_INFINITY;
		this.mark(Math.max(0, Math.min(to, end)));
		this.changed();
	}

	/** Past what is playing; given a key, only if that is still what is playing. */
	skip(key?: string): void {
		if (key !== undefined && this.now?.key !== key) return;
		this.next();
	}

	remove(key: string): void {
		const before = this.queue.length;
		this.queue = this.queue.filter((one) => one.key !== key);
		if (this.queue.length !== before) this.changed();
	}

	/** The holder's own player reached the end of the video. */
	ended(key: string): void {
		if (this.now?.key === key) this.next();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.room.off(RoomEvent.DataReceived, this.onData);
		this.room.off(RoomEvent.ParticipantConnected, this.announce);
		this.say({ t: "closed" });
		this.now = undefined;
		this.queue = [];
		this.changed();
	}

	private next(): void {
		this.now = this.queue.shift();
		this.mark(0);
		this.playing = this.now !== undefined;
		this.starting = this.now ? { key: this.now.key, since: performance.now() } : undefined;
		this.changed();
	}

	private mark(position: number): void {
		this.position = position;
		this.at = performance.now();
	}

	private changed(): void {
		this.version++;
		this.cached = undefined;
		this.announce();
		for (const listener of this.listeners) listener();
	}

	private readonly announce = (): void => {
		if (this.closed) return;
		this.say({ t: "state", show: this.state() });
	};

	private say(message: Message, to?: string[]): void {
		void this.room.localParticipant
			.publishData(new TextEncoder().encode(JSON.stringify(message)), {
				reliable: true,
				topic: TOPIC,
				...(to ? { destinationIdentities: to } : {}),
			})
			.catch(() => {});
	}

	private readonly onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
		if (topic !== TOPIC || !participant || this.closed) return;
		const message = parse(payload);
		if (!message) return;
		const by = participant.name || participant.identity;

		switch (message.t) {
			case "hello":
				this.announce();
				return;
			case "add":
				void this.add(String(message.text), by, participant.identity);
				return;
			case "play":
				this.play();
				return;
			case "pause":
				this.pause();
				return;
			case "seek":
				this.seek(Number(message.to));
				return;
			case "skip":
				this.skip(typeof message.key === "string" ? message.key : undefined);
				return;
			case "remove":
				this.remove(String(message.key));
				return;
		}
	};
}

function parse(payload: Uint8Array): Message | undefined {
	try {
		const value = JSON.parse(new TextDecoder().decode(payload)) as { t?: unknown };
		return typeof value?.t === "string" ? (value as Message) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A show as told by somebody else, if it is one: every field the type promises,
 * of the kind it promises, within reason. Anything else is dropped whole. It
 * arrives from another participant, and a field that is not what the page
 * expects -- a queue that is not a list -- took every viewer's page down.
 */
export function readShow(value: unknown): Show | undefined {
	const show = value as Record<string, unknown> | undefined;
	if (!show || typeof show !== "object") return undefined;
	const number = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0;
	const video = (x: unknown): Video | undefined => {
		const one = x as Record<string, unknown> | undefined;
		if (!one || typeof one !== "object") return undefined;
		if (typeof one.key !== "string" || one.key.length > 64 || typeof one.by !== "string") return undefined;
		if (typeof one.ticket !== "string" || !TICKET.test(one.ticket)) return undefined;
		return {
			key: one.key,
			by: one.by.slice(0, 100),
			ticket: one.ticket,
			duration: number(one.duration) ? (one.duration as number) : 0,
			live: one.live === true,
		};
	};

	if (typeof show.holder !== "string" || typeof show.playing !== "boolean") return undefined;
	if (!number(show.position) || !number(show.version) || !Array.isArray(show.queue) || show.queue.length > 500) return undefined;
	const now = show.now === undefined ? undefined : video(show.now);
	if (show.now !== undefined && !now) return undefined;
	const queue = show.queue.map(video);
	if (queue.some((one) => one === undefined)) return undefined;

	return {
		holder: show.holder,
		holderName: typeof show.holderName === "string" ? show.holderName.slice(0, 100) : "",
		now,
		queue: queue as Video[],
		playing: show.playing,
		position: show.position as number,
		version: show.version as number,
	};
}

/**
 * What a player should do, given where it is and where the show is.
 *
 * A small gap is closed by running a little fast or slow, which nobody notices;
 * jumping instead would stutter every viewer every few seconds over the jitter
 * of the network. A large one -- somebody arriving late, a seek, a player that
 * stalled -- is jumped, because catching up five per cent at a time would take
 * minutes.
 */
export function correction(
	local: number,
	expected: number,
	playing: boolean,
	/** The rate the player runs at now: a gap being closed is closed to SETTLED. */
	rate = 1,
): { seek?: number; rate: number } {
	const drift = local - expected;
	if (!playing) return Math.abs(drift) > PAUSED_CLOSE_ENOUGH ? { seek: expected, rate: 1 } : { rate: 1 };
	if (Math.abs(drift) > SEEK_AT) return { seek: expected, rate: 1 };
	const closing = rate !== 1;
	if (Math.abs(drift) <= (closing ? SETTLED : CLOSE_ENOUGH)) return { rate: 1 };
	const by = Math.abs(drift) > FAR ? FAST_NUDGE : NUDGE;
	return { rate: drift > 0 ? 1 - by : 1 + by };
}

/*
 * Everybody else: the show as heard from whoever runs it.
 */

/** A show as this browser knows it, and when it was told. */
export interface Seen {
	show: Show;
	/** performance.now() when it was heard, or for the holder, now. */
	at: number;
}

/** Where the show is at `now`, by what was last heard of it. */
export function expected(seen: Seen, now = performance.now()): number {
	const { show } = seen;
	const moved = show.position + (show.playing ? (now - seen.at) / 1000 : 0);
	return show.now?.duration ? Math.min(moved, show.now.duration) : moved;
}

const theatres = new WeakMap<Room, Theatre>();
const heard = new WeakMap<Room, Seen>();
/** The holder's own view of its show, rebuilt only when the show changes. */
const own = new WeakMap<Theatre, Seen>();
const watchers = new Set<() => void>();

function notify(): void {
	for (const watcher of watchers) watcher();
}

export function myTheatre(room: Room): Theatre | undefined {
	return theatres.get(room);
}

/** The show in a room, as far as this browser knows: its own, or one it heard. */
export function seenShow(room: Room): Seen | undefined {
	const mine = theatres.get(room);
	if (mine) {
		// The same object until the show changes. A fresh one on every read --
		// the position moves while it plays -- is a store that never settles,
		// and the panel and the player read this on every render.
		const show = mine.state();
		const kept = own.get(mine);
		if (kept && kept.show.version === show.version) return kept;
		const seen = { show, at: performance.now() };
		own.set(mine, seen);
		return seen;
	}

	const last = heard.get(room);
	if (!last) return undefined;
	if (performance.now() - last.at > STALE_MS || !room.remoteParticipants.has(last.show.holder)) return undefined;
	return last;
}

export function subscribeShow(listener: () => void): () => void {
	watchers.add(listener);
	return () => watchers.delete(listener);
}

/** Start running the show here. Refused while another is heard, and in an encrypted call. */
export function startTheatre(room: Room, deps: TheatreDeps): Theatre | undefined {
	const existing = theatres.get(room);
	if (existing) return existing;
	if (room.options.e2ee !== undefined || seenShow(room)) return undefined;

	const theatre = new Theatre(room, deps);
	theatres.set(room, theatre);
	theatre.subscribe(notify);
	notify();
	return theatre;
}

export function closeTheatre(room: Room): void {
	const theatre = theatres.get(room);
	if (!theatre) return;
	theatres.delete(room);
	theatre.close();
	notify();
}

/** Ask the show to do something: here if it runs here, otherwise of whoever runs it. */
export function command(room: Room, what: Command, by = room.localParticipant.name || room.localParticipant.identity): boolean {
	const mine = theatres.get(room);
	if (mine) {
		switch (what.t) {
			case "add":
				void mine.add(what.text, by);
				break;
			case "play":
				mine.play();
				break;
			case "pause":
				mine.pause();
				break;
			case "seek":
				mine.seek(what.to);
				break;
			case "skip":
				mine.skip(what.key);
				break;
			case "remove":
				mine.remove(what.key);
				break;
		}
		return true;
	}

	const seen = seenShow(room);
	if (!seen) return false;
	void room.localParticipant
		.publishData(new TextEncoder().encode(JSON.stringify(what)), {
			reliable: true,
			topic: TOPIC,
			destinationIdentities: [seen.show.holder],
		})
		.catch(() => {});
	return true;
}

/**
 * Listen for a show run elsewhere. Returns the function that stops.
 *
 * Asks once on arrival, so somebody joining partway through a film is told
 * where it is at once rather than at the next two-second word.
 */
export function hearShows(room: Room, onRefused: (why: Refusal) => void = () => {}): () => void {
	if (room.options.e2ee !== undefined) return () => {};

	const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
		if (topic !== TOPIC || !participant || theatres.has(room)) return;
		const message = parse(payload);
		const show = message?.t === "state" ? readShow(message.show) : undefined;
		if (show && show.holder === participant.identity) {
			const last = heard.get(room);
			// The same holder's older word, arriving after a newer one, is not news.
			if (last && last.show.holder === participant.identity && show.version < last.show.version) return;
			heard.set(room, {
				show: { ...show, holderName: participant.name || show.holderName },
				at: performance.now(),
			});
			notify();
		} else if (message?.t === "refused" && heard.get(room)?.show.holder === participant.identity) {
			const why = message.why;
			onRefused(why === "not_a_video" || why === "unavailable" ? why : "failed");
		} else if (message?.t === "closed" && heard.get(room)?.show.holder === participant.identity) {
			heard.delete(room);
			notify();
		}
	};

	const onLeft = (participant: RemoteParticipant) => {
		if (heard.get(room)?.show.holder === participant.identity) {
			heard.delete(room);
			notify();
		}
	};

	room.on(RoomEvent.DataReceived, onData);
	room.on(RoomEvent.ParticipantDisconnected, onLeft);
	void room.localParticipant
		.publishData(new TextEncoder().encode(JSON.stringify({ t: "hello" })), { reliable: true, topic: TOPIC })
		.catch(() => {});

	return () => {
		room.off(RoomEvent.DataReceived, onData);
		room.off(RoomEvent.ParticipantDisconnected, onLeft);
	};
}
