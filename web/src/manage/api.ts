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

/**
 * One relay, as a control node reads it.
 *
 * Reachable is separate from the counters and has to stay that way: a relay
 * holding no calls and a relay that did not answer are both zeros, and the
 * difference between quiet and down is most of why anybody opens this page.
 */
export interface NodeReading {
	name: string;
	url: string;
	reachable: boolean;
	detail?: string;
	node: string;
	ip: string;
	rooms: number;
	clients: number;
	tracksIn: number;
	tracksOut: number;
	outPerSec: number;
	cpus: number;
	load: number;
	startedAt?: string;
}

/**
 * The live reading, in either of the two shapes the server sends.
 *
 * A deployment holding its own media describes one process: it has a node
 * identity and an address it gives to clients. A control node holds none and
 * describes its relays instead — a list of them and a sum across the ones that
 * answered. The shapes differ because the things being described differ, and
 * pretending otherwise is what took this page down: `node` is absent on a
 * control node, and reading `node.id` through an optional chain that only
 * guarded the reading above it threw on a field that was never going to be
 * there.
 *
 * Both halves are optional here so that neither can be read without asking
 * which shape arrived.
 */
export interface Now {
	/** Present on a deployment that holds its own media. */
	node?: { id: string; ip: string };
	/** Present on a control node, along with nodes. */
	fleet?: boolean;
	nodes?: NodeReading[];
	asked?: number;
	answered?: number;
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

/** One administrator, as the management pages see them. */
export interface Administrator {
	trip: string;
	name: string;
	can: string[];
	added?: string;
	/** Whoever is reading, so a page can say so and guard their own way back in. */
	self?: boolean;
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

/** One media server, as the management pages see it. */
export interface Relay {
	name: string;
	url: string;
	region?: string;
	/** What people are shown instead of the name, which is a key and not a word. */
	label?: string;
	/** Held back for when nothing else can be reached. */
	fallback?: boolean;
	enabled: boolean;
	added?: string;
	/** Whether it answered when this page was drawn, from the control node. */
	reachable: boolean;
	latencyMs?: number;
	/** Why it did not answer, when it did not. A code is not sent for this one:
	 * it is a transport failure summarised by the server, and there is no fixed
	 * set of them to translate. */
	detail?: string;
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
	runtime: () => call<Runtime>("/runtime"),
	audit: () => call<Entry[]>("/audit"),
	policy: () => call<Policy>("/policy"),

	setPolicy: (openedBy: Opening) =>
		call<Policy>("/policy", { method: "PUT", body: JSON.stringify({ openedBy }) }),

	relays: () => call<{ relays: Relay[] }>("/relays"),

	addRelay: (relay: { name: string; url: string; region?: string; enabled?: boolean }) =>
		call<{ added: string }>("/relays", { method: "POST", body: JSON.stringify(relay) }),

	editRelay: (
		name: string,
		change: {
			name?: string;
			url?: string;
			region?: string;
			enabled?: boolean;
			label?: string;
			fallback?: boolean;
		},
	) =>
		call<{ updated: string }>(`/relays/${encodeURIComponent(name)}`, {
			method: "PATCH",
			body: JSON.stringify(change),
		}),

	// Text rather than JSON: it is a shell script, and it carries the enrolment
	// secret, which is why it is behind the same session as everything else here.
	relayScript: async (): Promise<string> => {
		const response = await fetch("/api/admin/relays/script", { credentials: "same-origin" });
		if (!response.ok) throw new Error(String(response.status));
		return response.text();
	},

	/**
	 * The one line to type on the new machine.
	 *
	 * Separate from the script rather than derived from it in the page, because
	 * the address and the secret are the server's to know: composing the command
	 * here would mean the client holding a second, quietly diverging idea of
	 * where this deployment lives.
	 */
	/**
	 * Everybody who may open these pages.
	 *
	 * The signature is the key and the whole of the identity. No passphrase
	 * travels here in either direction: this server is never told one, which is
	 * what makes a signature safe to send over a chat message.
	 */
	admins: () => call<Administrator[]>("/admins"),

	addAdmin: (admin: { trip: string; name: string; can: string[] }) =>
		call<{ added: string }>("/admins", { method: "POST", body: JSON.stringify(admin) }),

	changeAdmin: (trip: string, change: { name: string; can: string[] }) =>
		call<{ changed: string }>(`/admins/${encodeURIComponent(trip)}`, {
			method: "PATCH",
			body: JSON.stringify(change),
		}),

	/**
	 * Change your own passphrase.
	 *
	 * The current one is sent as well as the new one, even though the session
	 * already says who this is. A session proves somebody signed in; this asks
	 * whether the person at the keyboard now is that person, which is exactly
	 * the question an unattended laptop raises.
	 */
	changePassphrase: (current: string, next: string) =>
		call<{ trip: string }>("/admins/me/passphrase", {
			method: "POST",
			body: JSON.stringify({ current, next }),
		}),

	dropAdmin: (trip: string) =>
		call<{ removed: string }>(`/admins/${encodeURIComponent(trip)}`, { method: "DELETE" }),

	/**
	 * Put the relays in a chosen order.
	 *
	 * The whole list rather than one move at a time: two administrators each
	 * pressing an arrow would otherwise interleave into an order neither chose.
	 */
	reorderRelays: (names: string[]) =>
		call<{ ordered: number }>("/relays/order", {
			method: "PUT",
			body: JSON.stringify({ names }),
		}),

	relayCommand: () => call<{ command: string; domain: string; port: number }>("/relays/command"),

	dropRelay: (name: string) =>
		call<{ removed: string }>(`/relays/${encodeURIComponent(name)}`, { method: "DELETE" }),

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
