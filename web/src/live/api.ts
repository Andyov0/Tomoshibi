import { t } from "./i18n";
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
export type Opening = "anyone" | "admins";

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
			openedBy: body.openedBy === "admins" ? "admins" : "anyone",
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
export async function join(room: string, name: string, passphrase = ""): Promise<Join> {
	const previous = sessionStorage.getItem(IDENTITY_KEY) ?? undefined;

	const response = await fetch(`/api/rooms/${encodeURIComponent(room)}/join`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		// The passphrase goes in the body and nowhere else. A query parameter
		// would reach the access log, the browser history, and any Referer sent
		// onward, and none of those are places a secret can be taken back from.
		body: JSON.stringify({ identity: previous, name, passphrase }),
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
		case "server_error":
			return t("Something went wrong. Try again.");
		default:
			return t("Could not join {room}.", { room });
	}
}
