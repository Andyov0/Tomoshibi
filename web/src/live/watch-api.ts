/**
 * The watch gateway, as the client sees it: whether there is one, and what a
 * pasted link plays.
 *
 * Served by the server at /api/watch/*, which passes the request on to a
 * gateway the deployment runs; see internal/app/watch.go. A deployment without
 * one answers 404, which reads here as "no watching together".
 */

/** How a video plays from where it is. */
export interface Playable {
	/** A file a video element plays, an HLS playlist, or a YouTube video by its id. */
	kind: "file" | "hls" | "youtube";
	url?: string;
	id?: string;
}

/** What a link plays, as the gateway read it. */
export interface Resolved {
	/**
	 * The name the gateway filed it under, and the only thing about it a call
	 * passes around: everybody turns it back into the rest by asking the
	 * server (see videoInfo), so nobody in the call can tell everybody else's
	 * browser to fetch an address of their own.
	 */
	ticket: string;
	title: string;
	/** Seconds; nought where nobody could tell, or for something live. */
	duration: number;
	cover: string;
	/** The link as it was understood, for anybody who wants to open it themselves. */
	link: string;
	live: boolean;
	/**
	 * Played through the relay from the start, and from where it is only if the
	 * relay fails: for a video whose better qualities come only that way -- a
	 * site that hands them only to its own pages -- the relayed copy is the one
	 * worth watching, and the one from where it is a lower quality to fall back on.
	 */
	relay: boolean;
	/** Played from where it is, by whoever can reach it. */
	play: Playable;
	/** The same, relayed by the deployment, for whoever cannot. Same origin. */
	proxy: { kind: "file" | "hls"; url: string };
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** Whether this deployment can watch together, for this person. */
export async function watchReady(): Promise<boolean> {
	try {
		const response = await fetch("/api/watch/ready", { credentials: "same-origin" });
		return response.ok;
	} catch {
		return false;
	}
}

/** Read a resolved video defensively: it came from a gateway the client never sees. */
export function readResolved(body: Record<string, unknown>): Resolved | undefined {
	const play = (body.play ?? {}) as Record<string, unknown>;
	const proxy = (body.proxy ?? {}) as Record<string, unknown>;
	const kind = text(play.kind);
	const proxyKind = text(proxy.kind);

	if (kind !== "file" && kind !== "hls" && kind !== "youtube") return undefined;
	if (proxyKind !== "file" && proxyKind !== "hls") return undefined;
	const ticket = text(body.ticket);
	if (!TICKET.test(ticket)) return undefined;
	// The ticket's own relay on this server and nothing else: an address the
	// gateway named anywhere would be one this page fetched for it.
	if (text(proxy.url) !== `media?t=${ticket}`) return undefined;
	if (kind === "youtube" && !/^[\w-]{11}$/.test(text(play.id))) return undefined;
	if (kind !== "youtube" && !/^https?:\/\//.test(text(play.url))) return undefined;

	return {
		ticket,
		title: text(body.title).slice(0, 300),
		duration: count(body.duration),
		cover: /^https:\/\//.test(text(body.cover)) ? text(body.cover) : "",
		link: text(body.link),
		live: body.live === true,
		relay: body.relay === true,
		play: kind === "youtube" ? { kind, id: text(play.id) } : { kind, url: text(play.url) },
		proxy: { kind: proxyKind, url: `/api/watch/media?t=${ticket}` },
	};
}

/** What a ticket looks like: what the gateway issues, and nothing longer. */
export const TICKET = /^[\w-]{16,64}$/;

/*
 * What each ticket plays, as this page has learned it: asked of the server once
 * per ticket and kept for the life of the page, and filled straight in for the
 * person who resolved it.
 */
const infos = new Map<string, Resolved | "failed">();
const asking = new Set<string>();
const infoListeners = new Set<() => void>();

function infoChanged(): void {
	for (const listener of infoListeners) listener();
}

export function subscribeInfo(listener: () => void): () => void {
	infoListeners.add(listener);
	return () => infoListeners.delete(listener);
}

/** What a ticket plays, if this page knows yet; asks the server once if not. */
export function videoInfo(ticket: string): Resolved | "failed" | undefined {
	const known = infos.get(ticket);
	if (known !== undefined || asking.has(ticket) || !TICKET.test(ticket)) return known;

	asking.add(ticket);
	void fetch(`/api/watch/info?${new URLSearchParams({ t: ticket })}`, { credentials: "same-origin" })
		.then(async (response) => {
			const read = response.ok ? readResolved((await response.json()) as Record<string, unknown>) : undefined;
			// Only the ticket asked about: an answer naming another is not this one.
			infos.set(ticket, read && read.ticket === ticket ? read : "failed");
		})
		.catch(() => infos.set(ticket, "failed"))
		.finally(() => {
			asking.delete(ticket);
			infoChanged();
		});
	return undefined;
}

/** What this page knows a ticket plays, without asking. */
export function knownInfo(ticket: string): Resolved | "failed" | undefined {
	return infos.get(ticket);
}

/** What this page resolved itself, filled in so it is not asked for again. */
export function rememberInfo(found: Resolved): void {
	infos.set(found.ticket, found);
	infoChanged();
}

/** What a pasted link plays, or why it plays nothing. */
export async function resolveVideo(pasted: string): Promise<Resolved | "not_a_video" | "unavailable" | "failed"> {
	const params = new URLSearchParams({ url: pasted.slice(0, 2000) });
	try {
		const response = await fetch(`/api/watch/resolve?${params}`, { credentials: "same-origin" });
		if (response.status === 404) return "not_a_video";
		if (response.status === 422) return "unavailable";
		if (!response.ok) return "failed";
		return readResolved((await response.json()) as Record<string, unknown>) ?? "failed";
	} catch {
		return "failed";
	}
}
