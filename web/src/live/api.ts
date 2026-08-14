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
			return t("Too many requests. Wait a moment and try again.");
		case "invalid_room":
			return t("Room names may only contain lowercase letters, digits, and inner dashes.");
		case "server_error":
			return t("The server could not complete the request.");
		default:
			return t("Could not join {room}.", { room });
	}
}
