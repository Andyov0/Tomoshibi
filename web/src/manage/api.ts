/**
 * What the management pages ask the server.
 *
 * Nothing here carries a credential. The session is a cookie the browser was
 * given and cannot read, and the token that can actually close a room lives in
 * the server and is spent there — a page holding one would put it a single
 * cross-site script away from somebody who should not have it.
 */

export interface Who {
	trip: string;
	name?: string;
	can: string[];
}

export interface Now {
	node: { id: string; ip: string };
	since: string;
	rooms: number;
	clients: number;
	tracks: { in: number; out: number };
	bytes: { in: number; out: number; inPerSec: number; outPerSec: number; window: number };
	packets: { nackTotal: number; nackPerSec: number };
	cpu: { count: number; load: number };
}

export interface Sample {
	at: string;
	in: number;
	out: number;
	rooms: number;
	clients: number;
	nack: number;
}

export interface LiveRoom {
	name: string;
	sid: string;
	participants: number;
	publishers: number;
	createdAt: string;
}

export interface KnownRoom {
	name: string;
	firstSeen: string;
	lastSeen: string;
}

export interface Layer {
	quality: string;
	width: number;
	height: number;
	bitrate: number;
}

export interface Track {
	sid: string;
	source: string;
	kind: string;
	muted: boolean;
	width: number;
	height: number;
	mime: string;
	simulcast: boolean;
	layers: Layer[];
}

export interface Participant {
	identity: string;
	name: string;
	sid: string;
	state: string;
	joinedAt: string;
	publisher: boolean;
	trip: { mark: string; proven: boolean };
	tracks: Track[];
}

export interface Check {
	name: string;
	verdict: "good" | "warn" | "unknown";
	found: string;
	remedy?: string;
}

export interface Entry {
	at: string;
	trip: string;
	name?: string;
	action: string;
	room?: string;
	target?: string;
	failed?: boolean;
	reason?: string;
}

/** Who may use a name nobody has used before. */
export type Opening = "anyone" | "admins";

/**
 * The policy, in the three forms worth telling apart.
 *
 * One value would be enough to draw a switch and not enough to explain it.
 * These separate the choice somebody made from the file it started in and from
 * what the deployment can actually carry out, which is how the two ways this
 * goes quietly wrong become something a page can point at.
 */
export interface Policy {
	/** What the server is doing. */
	openedBy: Opening;
	/** What was last set, before it was reconciled against who exists. */
	chosen: Opening;
	/** The configuration file's value, which is the starting one and no more. */
	configured: Opening;
	/**
	 * How long a name stays used after the last join, in seconds, or nought
	 * where names are kept for ever.
	 *
	 * The other half of the same sentence as the switch above it: that says who
	 * may open a room and this says how long one stays open. Reading either
	 * without the other is reading half a rule.
	 */
	remember: number;
}

export interface Runtime {
	meet: Record<string, unknown>;
	rtc: Record<string, unknown>;
	rooms: Policy;
	credentials: { key: string };
	codecs: string[];
}

/** Raised when the session has gone, so a caller can send somebody to sign in. */
export class SignedOut extends Error {
	constructor() {
		super("signed out");
	}
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`/api/admin${path}`, {
		...init,
		headers: { "content-type": "application/json", ...init?.headers },
	});

	if (response.status === 401) throw new SignedOut();

	if (!response.ok) {
		const reason = await response
			.json()
			.then((body: { error?: string }) => body.error)
			.catch(() => undefined);

		throw new Error(explain(reason, response.status));
	}

	if (response.status === 204) return undefined as T;

	return (await response.json()) as T;
}

/**
 * The server sends a code. The sentence belongs here, with the rest of the
 * words, and a code this build does not know falls back rather than being shown
 * raw: `media_server_unreachable` on screen is an internal name escaping.
 */
function explain(reason: string | undefined, status: number): string {
	switch (reason) {
		case "too_many_attempts":
			return "Too many attempts. Wait a minute and try again.";
		case "refused":
			return "That passphrase is not an administrator's.";
		case "not_allowed":
			return "This account may watch, but not change anything.";
		case "no_such_room":
			return "That room has ended.";
		case "media_server_unreachable":
			return "The media server did not answer.";
		case "no_track":
			return "No track was named.";
		case "no_such_policy":
			return "Rooms are opened either by anyone or by administrators, and that was neither.";
		case "store_unwritable":
			return "The change could not be written down, so nothing was changed.";
		default:
			return `The server refused the request (HTTP ${status}).`;
	}
}

export const api = {
	whoami: () => call<Who>("/session"),
	signIn: (passphrase: string) =>
		call<Who>("/session", { method: "POST", body: JSON.stringify({ passphrase }) }),
	signOut: () => call<void>("/session", { method: "DELETE" }),

	now: () => call<Now>("/now"),
	history: () => call<Sample[]>("/history"),
	rooms: () => call<{ live: LiveRoom[]; known: KnownRoom[] | null }>("/rooms"),
	participants: (room: string) =>
		call<Participant[]>(`/rooms/${encodeURIComponent(room)}/participants`),
	health: () => call<Check[]>("/health"),
	runtime: () => call<Runtime>("/runtime"),
	audit: () => call<Entry[]>("/audit"),
	policy: () => call<Policy>("/policy"),

	setPolicy: (openedBy: Opening) =>
		call<Policy>("/policy", { method: "PUT", body: JSON.stringify({ openedBy }) }),

	closeRoom: (room: string) => call<void>(`/rooms/${encodeURIComponent(room)}`, { method: "DELETE" }),
	remove: (room: string, identity: string) =>
		call<void>(`/rooms/${encodeURIComponent(room)}/participants/${encodeURIComponent(identity)}`, {
			method: "DELETE",
		}),
	mute: (room: string, identity: string, track: string) =>
		call<void>(
			`/rooms/${encodeURIComponent(room)}/participants/${encodeURIComponent(identity)}/mute`,
			{ method: "POST", body: JSON.stringify({ track }) },
		),
};
