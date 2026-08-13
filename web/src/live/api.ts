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
export async function join(room: string, name: string): Promise<Join> {
	const previous = sessionStorage.getItem(IDENTITY_KEY) ?? undefined;

	const response = await fetch(`/api/rooms/${encodeURIComponent(room)}/join`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ identity: previous, name }),
	});

	if (!response.ok) {
		const detail = await response
			.json()
			.then((body) => (body as { error?: string }).error)
			.catch(() => undefined);

		throw new Error(detail ?? `could not join ${room}`);
	}

	const result = (await response.json()) as Join;
	sessionStorage.setItem(IDENTITY_KEY, result.identity);

	return result;
}
