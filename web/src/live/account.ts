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
