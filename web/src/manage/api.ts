import { linkIs } from "./units";
import { t } from "@/live/i18n";

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
	inPerSec: number;
	/** Since this relay's process started, not since the month began. */
	bytesIn: number;
	bytesOut: number;
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

/**
 * One bucket of the trend.
 *
 * The rates are the mean over the bucket and the peaks are the highest single
 * reading inside it, which are different questions and both worth asking: a
 * six-hour mean says what the evening cost and hides the two minutes that hit
 * the ceiling. Rooms and clients are gauges and have no peak, because they move
 * on the timescale of a meeting rather than of a packet — their mean already
 * describes their shape.
 *
 * `n` is how many five-second readings are behind the bucket. A bucket holding
 * one of a possible thirty-six is not wrong, but it is not the same claim as a
 * full one.
 */
export interface Point {
	at: string;
	in: number;
	out: number;
	inPeak: number;
	outPeak: number;
	rooms: number;
	clients: number;
	nack: number;
	nackPeak: number;
	n: number;
}

/**
 * The load over a stretch of time, as the server answers it.
 *
 * The width of a bucket comes with the points and is not inferred from them.
 * The same array is an hour or half a year depending on `step`, and a page that
 * assumed either would label an axis with the wrong day and be believed. The
 * range comes too, because what was asked for is not always what could be
 * answered: a deployment three days old asked for six months has three days.
 */
export interface Trend {
	span: string;
	/** Seconds to a bucket. */
	step: number;
	from: string;
	to: string;
	points: Point[];
}

export interface LiveRoom {
	name: string;
	sid: string;
	participants: number;
	publishers: number;
	createdAt: string;
	/**
	 * Which relay the meeting is on.
	 *
	 * From this deployment's own record and not from the media server, which
	 * reports a room from whichever node was asked — every node answers for the
	 * whole cluster, so the field that looks like it should hold this holds the
	 * machine that answered.
	 */
	relay?: string;
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
	trip: { mark: string; proven: boolean; account?: boolean };
	tracks: Track[];
	/**
	 * Where they came from, as this deployment resolved it at the join.
	 *
	 * The media server cannot say: it sees each participant over a signalling
	 * socket from a relay, so the address it holds is the relay's.
	 */
	address?: string;
	/** The relay they came in through, which is not always the one holding the room. */
	relay?: string;
	/** The relay holding the room, sent only where it is a different machine. */
	holding?: string;
	/** Their media is being forwarded through `relay` to `holding`. */
	forwarded?: boolean;
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

/** Somebody who was given a way in. */
export interface Account {
	name: string;
	trip: string;
	/** Whether they have chosen a picture. The picture itself is fetched by URL. */
	avatar?: boolean;
	created?: string;
	lastSeen?: string;
	blocked?: boolean;
	note?: string;
}

/** Who may use a name nobody has used before. */
export type Opening = "anyone" | "signed" | "admins";

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
 * words.
 *
 * There were nine of these and the server sends forty-two, so a new account
 * with a name somebody already had said "HTTP 409", and a passphrase two
 * characters short said "HTTP 400". Every one of them now has a sentence, and
 * every sentence goes through the dictionary like the rest of the interface —
 * which it did not, because this file had no import at all.
 */
function explain(reason: string | undefined, status: number): string {
	switch (reason) {
		case "too_many_attempts":
			return t("Too many attempts. Wait a minute and try again.");
		case "refused":
			return t("That passphrase is not an administrator's.");
		case "wrong_passphrase":
			return t("That passphrase is not an administrator's.");
		case "not_allowed":
			return t("This account may watch, but not change anything.");
		case "unknown_capability":
			return t("This account may watch, but not change anything.");
		case "signed_out":
			return t("That session has ended. Sign in again.");
		case "no_such_room":
			return t("That room has ended.");
		case "media_server_unreachable":
			return t("The media server did not answer.");
		case "no_media_here":
			return t("This node holds no media, so there is nothing to ask it.");
		case "no_track":
			return t("No track was named.");
		case "no_such_span":
			return t("That is not a stretch of time this server can answer for.");
		case "no_such_policy":
			return t("Rooms are opened either by anyone or by administrators, and that was neither.");
		case "store_unwritable":
			return t("The change could not be written down, so nothing was changed.");
		case "store_unavailable":
			return t("The store is not answering, so nothing was changed.");
		case "name_taken":
			return t("That name is already taken.");
		case "name_too_long":
			return t("That name is too long.");
		case "bad_name":
			return t("That name cannot be used.");
		case "no_such_account":
			return t("There is no account by that name.");
		case "no_passphrase":
			return t("A passphrase is needed.");
		case "passphrase_too_short":
			return t("That passphrase is too short.");
		case "passphrase_in_use":
			return t("That passphrase is already somebody else's.");
		case "passphrase_unchanged":
			return t("That is the passphrase already in use.");
		case "already_an_administrator":
			return t("They are an administrator already.");
		case "no_such_administrator":
			return t("There is no administrator by that signature.");
		case "last_moderator":
			return t("That is the last administrator who can change anything, so it stays.");
		case "not_a_signature":
			return t("That is not a signature.");
		case "relay_exists":
			return t("A relay by that name is already here.");
		case "no_such_relay":
			return t("There is no relay by that name.");
		case "relay_no_name":
			return t("A relay needs a name.");
		case "relay_long_name":
			return t("That relay name is too long.");
		case "relay_no_url":
			return t("A relay needs an address.");
		case "relay_bad_url":
			return t("That is not an address a client can dial.");
		case "relay_long_region":
			return t("That region name is too long.");
		case "relay_refused":
			return t("The relay refused.");
		case "no_relay_list":
			return t("This deployment keeps no relay list.");
		case "bad_address":
			return t("That is not an address.");
		case "bad_prefix":
			return t("That prefix cannot be used.");
		case "no_enrolment":
			return t("This deployment does not let machines enrol themselves.");
		case "wrong_secret":
			return t("That is not the enrolment secret.");
		case "no_certificate":
			return t("There is no certificate to hand out.");
		case "unreadable_request":
			return t("The request could not be read.");
		case "avatar_too_large":
			return t("That picture is too large.");
		case "under_score":
			return t("A name cannot start with an underscore.");
		default:
			// A code this build has no sentence for. Better a status than the
			// code itself: media_server_unreachable on a screen is an internal
			// name escaping, and it escapes untranslated.
			return t("The server refused the request.") + ` (HTTP ${status})`;
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
	/** Not offered to, or usable by, anybody who is not an administrator. */
	adminOnly?: boolean;
	/** Where it answers STUN binding requests, as host:port. */
	probe?: string;
	/** host:port of its TURN server, where it can forward a room it is not holding. */
	turn?: string;
	/** Whether it may carry a call held on another machine. */
	forwards?: boolean;
	/**
	 * Relays this one must not forward with, by name.
	 *
	 * In either direction: if either of a pair lists the other, the pair does not
	 * forward. Reachability between two machines is a fact about the networks
	 * between them and nothing can derive it — two relays can both be fast, both
	 * be in the same country, and still carry nothing usable between each other.
	 */
	apart?: string[];
	/**
	 * Whether this relay may stand in for one that cannot reach a room.
	 *
	 * For a fleet with machines on both sides of a border: somebody who lands on
	 * a pair that carries nothing is sent here instead, which is the one way
	 * their call can go rather than not going at all.
	 */
	bridge?: boolean;
	/**
	 * Where the machine is, in degrees.
	 *
	 * Two things read it and both were dead until it could be set. The globe on
	 * the join screen draws a point per relay and filters out any without a
	 * place, so it drew nothing at all; and the enrolment writes a distance-aware
	 * node selector only where at least two relays have one, so every machine
	 * brought up by the script fell back to picking a media node at random --
	 * which is the fault recorded in internal/store/relays.go as having put
	 * people into meetings on machines they could not reach.
	 *
	 * The server has accepted these since the field existed. Nothing sent them:
	 * the panel had no box and the type did not name them, so the only way to
	 * set one was curl.
	 */
	lat?: number;
	lon?: number;
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
	/**
	 * Both, always.
	 *
	 * A passphrase alone is checked against every administrator at once, so a
	 * list of leaked passphrases run at this endpoint succeeds if any one person
	 * on the deployment has ever reused one. The name makes a guess have to be
	 * aimed at somebody.
	 */
	signIn: (name: string, passphrase: string) =>
		call<Who>("/session", { method: "POST", body: JSON.stringify({ name, passphrase }) }),
	signOut: () => call<void>("/session", { method: "DELETE" }),

	now: () => call<Now>("/now"),

	/**
	 * The trend, over a named span or between two moments.
	 *
	 * The span is a key rather than a number of seconds, so that the page and
	 * the server agree on what a month is without either of them saying it in a
	 * query string. A pair of moments is the only way to ask about a window
	 * that has already passed: every named span ends now.
	 */
	history: (span: string, range?: { from: string; to: string }) =>
		call<Trend>(
			`/history?${new URLSearchParams(range ? { from: range.from, to: range.to } : { span })}`,
		),
	rooms: () => call<{ live: LiveRoom[]; known: KnownRoom[] | null }>("/rooms"),
	participants: (room: string) =>
		call<Participant[]>(`/rooms/${encodeURIComponent(room)}/participants`),
	/**
	 * The settings this deployment is running under.
	 *
	 * Also where the pages learn what the network link is thought to carry, which
	 * three of them draw against. Told here rather than threaded down through
	 * three components at three depths: the figure belongs to the deployment
	 * rather than to any of them, and every page that draws a bandwidth bar has
	 * already asked for this.
	 */
	runtime: async () => {
		const said = await call<Runtime>("/runtime");
		linkIs(said.meet?.linkMbits as number | undefined);

		return said;
	},
	policy: () => call<Policy>("/policy"),

	/**
	 * Where a room is held.
	 *
	 * A meeting lives on one machine and the media server has no migration, so
	 * `now` is the difference between two genuinely different actions: without
	 * it the change waits for the next call under that name, and with it the
	 * call in progress is ended so everybody comes back to the new machine.
	 */
	placeRoom: (room: string, relay: string, now: boolean) =>
		call<{ room: string; relay: string; moved: boolean }>(
			`/rooms/${encodeURIComponent(room)}/relay`,
			{ method: "PUT", body: JSON.stringify({ relay, now }) },
		),

	/**
	 * Which relay one person comes in through.
	 *
	 * Takes effect on their next join and then goes away, so it moves somebody
	 * once rather than overruling their own choice for ever. They are removed
	 * from the call as part of it, because a browser holds its connection to the
	 * machine it dialled and nothing in the protocol asks it to move.
	 */
	placePerson: (room: string, identity: string, relay: string) =>
		call<{ relay: string }>(
			`/rooms/${encodeURIComponent(room)}/participants/${encodeURIComponent(identity)}/relay`,
			{ method: "PUT", body: JSON.stringify({ relay }) },
		),

	setPolicy: (openedBy: Opening) =>
		call<Policy>("/policy", { method: "PUT", body: JSON.stringify({ openedBy }) }),

	relays: () => call<{ relays: Relay[] }>("/relays"),

	/**
	 * Ask one relay whether it is there.
	 *
	 * Reading the list measures every relay, which is what drawing the page
	 * needs and is not what a button on one row means. It used to be both: the
	 * row's button re-read the list, so asking after the machine somebody had
	 * just restarted dialled the whole fleet and took as long as the slowest
	 * one — which, where a relay is genuinely down, is its full timeout, on
	 * every press, about a machine that is not the one in question.
	 *
	 * The reply is a row in the shape the list sends, so what comes back can go
	 * where the old reading was rather than being reconciled with it.
	 */
	checkRelay: (name: string) => call<Relay>(`/relays/${encodeURIComponent(name)}/check`),

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
			probe?: string;
			turn?: string;
			forwards?: boolean;
			apart?: string[];
			bridge?: boolean;
			fallback?: boolean;
			adminOnly?: boolean;
			lat?: number;
			lon?: number;
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

	/** Everybody who has an account here. */
	accounts: () => call<Account[]>("/accounts"),

	/**
	 * Make one.
	 *
	 * The passphrase goes up and is turned into a signature there; it is not
	 * stored and cannot be read back, which is why the page shows it once and
	 * says so.
	 */
	addAccount: (name: string, passphrase: string) =>
		call<{ name: string; trip: string }>("/accounts", {
			method: "POST",
			body: JSON.stringify({ name, passphrase }),
		}),

	changeAccount: (
		name: string,
		change: { name?: string; passphrase?: string; blocked?: boolean; note?: string },
	) =>
		call<{ name: string; trip: string }>(`/accounts/${encodeURIComponent(name)}`, {
			method: "PATCH",
			body: JSON.stringify(change),
		}),

	dropAccount: (name: string) =>
		call<{ removed: string }>(`/accounts/${encodeURIComponent(name)}`, { method: "DELETE" }),

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
