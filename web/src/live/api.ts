import { t } from "./i18n";
import { preferred } from "./relays";
/*
 * The keys below still say the name this was called before.
 *
 * Deliberate, and not an oversight to tidy. They are what a browser already has
 * written down: a display name, a device choice, a language, an identity that
 * keeps somebody the same person across a reload. Renaming them renames nothing
 * — it abandons all of it, and everybody using this finds themselves nameless
 * and back in English on the morning after a deployment.
 */
const IDENTITY_KEY = "meet-live.identity";

/**
 * Who may use a name nobody has used before.
 *
 * A property of the deployment and never of the reader. The server will not say
 * whether this particular person may open a room, because that turns on a
 * passphrase they have not typed yet, and an endpoint answering it would be an
 * unauthenticated way to test a guessed administrator's one.
 *
 * So the screen says who rooms are opened by, and the answer about any one
 * person arrives where it always did: on pressing Join.
 */
export type Opening = "anyone" | "signed" | "admins";

/** What the server said about itself. */
export interface Deployment {
	openedBy: Opening;
	/**
	 * Where the code running here can be read.
	 *
	 * Shown rather than kept, because this is licensed under the AGPL and its
	 * thirteenth section obliges whoever offers a program over a network to
	 * offer its source to the people using it that way. The people using this
	 * one are on this page.
	 */
	source: string;
}

/** What a deployment that will not say anything is taken to be. */
const PLAIN: Deployment = { openedBy: "anyone", source: "" };

/**
 * Ask the server about itself.
 *
 * Falls back to the answer every deployment starts with. A server that will not
 * say should leave the page reading the way it has always read rather than
 * warning about a restriction that may not exist — and if one does exist, the
 * join is still refused by the only thing that decides it.
 */
export async function deployment(): Promise<Deployment> {
	try {
		const response = await fetch("/api/deployment");
		if (!response.ok) return PLAIN;

		const body = (await response.json()) as Partial<Deployment>;

		return {
			// All three, and not two.
			//
			// This narrowed "signed" to "anyone", which quietly disabled the
			// middle setting on the only screen that could act on it: the server
			// went on refusing a new name from anybody without a passphrase, and
			// the page went on saying nothing about it, so somebody who set the
			// policy saw no change and somebody who hit it got a refusal with no
			// warning beforehand. The narrowing was there to keep an unknown
			// value from reaching the interface, which is right — but it has to
			// let through the values that exist.
			openedBy:
				body.openedBy === "admins" || body.openedBy === "signed"
					? body.openedBy
					: "anyone",
			source: typeof body.source === "string" ? body.source : "",
		};
	} catch {
		return PLAIN;
	}
}

/** What the server hands back for one room. */
export interface Join {
	url: string;
	token: string;
	identity: string;
	room: string;
	/** What to call the machine this call was sent to. */
	relay?: string;
	/**
	 * What to call the machine the meeting is actually on, where that is not the
	 * one that was dialled.
	 *
	 * Said by the server, which picked both. It used to be worked out here by
	 * comparing the relay against the region the media server reports for the
	 * node holding the room — which only ever differed on a deployment that had
	 * set a region on every relay, and none had, so a forwarded call looked
	 * exactly like a direct one.
	 */
	holding?: string;
	/**
	 * Where to send media, when that is not the machine holding the room.
	 *
	 * A meeting lives on one server, so somebody joining a room that is already
	 * running would otherwise have their media go straight past the relay they
	 * picked — the choice would be theirs to make and would change nothing. When
	 * this is present the picked relay forwards instead: one extra hop, in
	 * exchange for the call entering the country the caller is in.
	 *
	 * Absent whenever the two are the same machine, which is most calls, and
	 * absent when the picked relay does not forward. Both mean: connect
	 * directly, as before.
	 */
	forward?: { url: string; username: string; credential: string };
}

/**
 * Ask the server to authorise us for a room.
 *
 * The identity from a previous join is sent back so a reload keeps the same one.
 * Without it a refresh would appear to everybody else as a second participant
 * arriving while the first is still being cleaned up.
 *
 * A passphrase, when given, is what turns the display name into one nobody else
 * can wear: the server derives a signature from it and puts that in the
 * identity, which the media server enforces. It is sent on every join rather
 * than once, so changing or dropping it takes effect immediately.
 *
 * The display name goes with the request rather than being set after
 * connecting, so it is signed into the token: nobody can rename themselves to
 * somebody else mid-call, and the name is there in the first roster update
 * rather than replacing a raw identity a moment later.
 *
 * Kept in session storage rather than local storage, because the identity
 * belongs to the tab and not to the browser. Local storage is shared across
 * every tab on the origin, so two of them would claim one identity and the
 * second would evict the first from the room.
 */
export async function join(
	room: string,
	name: string,
	passphrase = "",
	chosen = "",
	invite = "",
): Promise<Join> {
	const previous = sessionStorage.getItem(IDENTITY_KEY) ?? undefined;

	// Which relay answered fastest, on a deployment that spreads its media over
	// several. Empty everywhere else, and empty here if measuring failed: the
	// server treats it as a preference and falls back to keeping the room
	// together, so a call still happens either way.
	//
	// Unless somebody said which one, in which case no measurement is taken at
	// all. Not because it would be wrong, but because it would be a second and
	// a half of waiting to produce an answer already overruled — and because
	// somebody who picks a relay by hand usually does so precisely when the
	// measurement is telling them the wrong thing.
	const relay = chosen || (await preferred());

	// The invite goes in the query and the passphrase does not, which looks
	// inconsistent and is not. A passphrase is a secret and a query parameter
	// reaches the access log, the history and any Referer sent onward. An invite
	// is a link somebody was sent — it is already in all three, by design, and
	// the server reads it from the same place whether it arrives on the join or
	// on the page.
	const url = `/api/rooms/${encodeURIComponent(room)}/join${
		invite ? `?invite=${encodeURIComponent(invite)}` : ""
	}`;

	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		// The passphrase goes in the body and nowhere else. A query parameter
		// would reach the access log, the browser history, and any Referer sent
		// onward, and none of those are places a secret can be taken back from.
		body: JSON.stringify({ identity: previous, name, passphrase, relay }),
	});

	if (!response.ok) {
		const reason = await response
			.json()
			.then((body) => (body as { error?: string }).error)
			.catch(() => undefined);

		throw new Error(explain(reason, room));
	}

	const result = (await response.json()) as Join;
	sessionStorage.setItem(IDENTITY_KEY, result.identity);

	return result;
}

/**
 * Turn what the server refused into something a person can read.
 *
 * The server sends a code and nothing else, so that the words live in one place
 * and one language at a time. A code this build does not recognise falls back to
 * the general failure rather than being shown raw: `rate_limited` on screen is
 * an implementation detail escaping, and it would escape untranslated.
 */
function explain(reason: string | undefined, room: string): string {
	switch (reason) {
		case "rate_limited":
			return t("Too many attempts. Try again in a moment.");
		case "invalid_room":
			return t("Room names can only use lowercase letters, numbers and dashes.");
		// Said as a fact about the room and never as a fact about the person
		// reading it. They were not judged and nothing about them was found
		// wanting: the name has simply never been used, and on this deployment
		// that is not something they can change.
		case "room_not_open":
			return t("{room} isn't open. Ask the organiser for the link.", {
				room,
			});
		// Said plainly, and about the passphrase rather than about the person.
		// It is the only thing this server recognises anybody by, and somebody
		// who is reading this may well not know why — telling them to ask is
		// more use than an apology.
		// Named rather than swapped, so somebody who picked a server they may not
		// use finds out they picked it, instead of ending up somewhere else and
		// wondering whether the picker did anything.
		case "relay_not_allowed":
			return t("Access denied. That server is for administrators.");
		case "blocked":
			return t("This passphrase cannot join. Ask the organiser.");
		case "server_error":
			return t("Something went wrong. Try again.");
		default:
			return t("Could not join {room}.", { room });
	}
}
