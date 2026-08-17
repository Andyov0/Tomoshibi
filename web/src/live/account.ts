/**
 * Who is signed in, from the front page's point of view.
 *
 * The account pages are a separate document with their own bundle; this is the
 * little the join page needs to know — whether there is a session, and what to
 * call the person holding it. Deliberately not the account pages' own client:
 * the join page should not carry the code for changing a passphrase, and the two
 * would drift the moment either changed.
 */
export interface Me {
	name: string;
	trip: string;
	avatar?: string;
	/**
	 * Whether this person also runs the deployment.
	 *
	 * Told to them so the page can offer the way to the management pages, and
	 * for nothing else. Nothing here is authorised by it: those pages ask the
	 * administrator list themselves, on every request, and would refuse a
	 * browser that had been told otherwise.
	 */
	admin?: boolean;
}

/** The account this browser is signed in to, if any. */
export async function me(): Promise<Me | undefined> {
	try {
		const response = await fetch("/api/account/me", { credentials: "same-origin" });

		return response.ok ? ((await response.json()) as Me) : undefined;
	} catch {
		// A deployment with no accounts answers 404 and a broken one answers
		// nothing. Both mean the same thing here: nobody is signed in, carry on
		// as the page did before accounts existed.
		return undefined;
	}
}

/** Sign in, or say that the pair does not go together. */
export async function signIn(name: string, passphrase: string): Promise<Me> {
	const response = await fetch("/api/account/session", {
		method: "POST",
		headers: { "content-type": "application/json" },
		credentials: "same-origin",
		body: JSON.stringify({ name, passphrase }),
	});

	if (!response.ok) throw new Error("not_yours");

	return (await response.json()) as Me;
}

export async function signOut(): Promise<void> {
	await fetch("/api/account/session", { method: "DELETE", credentials: "same-origin" });
}

/**
 * The invite this page was opened with, if it was opened with one.
 *
 * From the query rather than the hash, because the hash is where the room name
 * lives and because a link somebody pastes into a chat client has its query
 * preserved by every one of them and its fragment by fewer.
 */
export function inviteToken(): string {
	return new URLSearchParams(window.location.search).get("invite") ?? "";
}

/** What room an invite is for, or why it is no good. */
export async function invited(token: string): Promise<{ room?: string; error?: string }> {
	try {
		const response = await fetch(`/api/invites/${encodeURIComponent(token)}`);

		if (response.ok) return (await response.json()) as { room: string };

		const body = (await response.json().catch(() => ({}))) as { error?: string };

		return { error: body.error ?? "no_such_invite" };
	} catch {
		return { error: "no_such_invite" };
	}
}

/**
 * Whether a meeting is happening under this name.
 *
 * Asked before somebody is taken any further, in both directions: starting a
 * meeting under a name already in use would put them in somebody else's call,
 * and joining one that is not there takes them to a camera preview for a room
 * that does not exist — which reads as the name being wrong only if they
 * remember typing it, and as the site being broken otherwise.
 *
 * Answered only to somebody signed in. A room here is a name and nothing else,
 * so this would otherwise be a way to find meetings by guessing at them.
 */
export async function meeting(room: string): Promise<boolean | undefined> {
	try {
		const response = await fetch(`/api/rooms/${encodeURIComponent(room)}/live`, {
			credentials: "same-origin",
		});

		if (!response.ok) return undefined;

		return ((await response.json()) as { live: boolean }).live;
	} catch {
		// Unknown rather than either. A check that cannot be made must not become
		// a refusal: the join itself is the authority and says so properly.
		return undefined;
	}
}
