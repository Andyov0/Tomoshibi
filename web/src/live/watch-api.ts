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
	/**
	 * A file a video element plays, an HLS playlist, a YouTube video by its id,
	 * or nothing but the relay: a media server whose every address carries the
	 * deployment's account, which no viewer is given.
	 */
	kind: "file" | "hls" | "youtube" | "relay";
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

	if (kind !== "file" && kind !== "hls" && kind !== "youtube" && kind !== "relay") return undefined;
	if (proxyKind !== "file" && proxyKind !== "hls") return undefined;
	const ticket = text(body.ticket);
	if (!TICKET.test(ticket)) return undefined;
	// The ticket's own relay on this server and nothing else: an address the
	// gateway named anywhere would be one this page fetched for it.
	if (text(proxy.url) !== `media?t=${ticket}`) return undefined;
	if (kind === "youtube" && !/^[\w-]{11}$/.test(text(play.id))) return undefined;
	if ((kind === "file" || kind === "hls") && !/^https?:\/\//.test(text(play.url))) return undefined;
	// A picture from the relay -- a media server's poster, fetched with the
	// deployment's account -- or one on the open web; nothing else.
	const cover = text(body.cover);
	const relayedCover = RELAYED.test(cover) ? `/api/watch/${cover}` : "";

	return {
		ticket,
		title: text(body.title).slice(0, 300),
		duration: count(body.duration),
		cover: relayedCover || (/^https:\/\//.test(cover) ? cover : ""),
		link: text(body.link),
		live: body.live === true,
		relay: body.relay === true,
		play: kind === "youtube" ? { kind, id: text(play.id) } : kind === "relay" ? { kind } : { kind, url: text(play.url) },
		proxy: { kind: proxyKind, url: `/api/watch/media?t=${ticket}` },
	};
}

/** What a ticket looks like: what the gateway issues, and nothing longer. */
export const TICKET = /^[\w-]{16,64}$/;

/** A relayed address, relative to /api/watch/: a ticket's media, and nothing else. */
const RELAYED = /^media\?t=[\w-]{16,64}$/;

/*
 * The media servers the deployment has an account on: browsed and searched by
 * somebody signed in, choosing what everybody will watch.
 */

export interface MediaServer {
	key: string;
	name: string;
}

export interface MediaItem {
	id: string;
	name: string;
	type: string;
	/** Something to open: a library, a folder, a series, a season. */
	folder: boolean;
	/** Something to watch. */
	playable: boolean;
	year: number;
	duration: number;
	/** The poster, from this server, or "". */
	image: string;
}

const IMAGE = /^library\?op=image&server=[\w-]+&id=[0-9a-fA-F]+&tag=[\w-]*$/;

function readItem(value: Record<string, unknown>): MediaItem | undefined {
	const id = text(value.id);
	if (!/^[0-9a-fA-F]{1,64}$/.test(id)) return undefined;
	const image = text(value.image);
	return {
		id,
		name: text(value.name).slice(0, 300),
		type: text(value.type),
		folder: value.folder === true,
		playable: value.playable === true,
		year: count(value.year),
		duration: count(value.duration),
		image: IMAGE.test(image) ? `/api/watch/${image}` : "",
	};
}

async function library(params: Record<string, string>): Promise<Record<string, unknown> | undefined> {
	try {
		const response = await fetch(`/api/watch/library?${new URLSearchParams(params)}`, { credentials: "same-origin" });
		return response.ok ? ((await response.json()) as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** The media servers there are, for this person; none where there are none or nobody signed in. */
export async function mediaServers(): Promise<MediaServer[]> {
	const found = await library({ op: "servers" });
	if (!Array.isArray(found?.servers)) return [];
	return found.servers
		.map((one: Record<string, unknown>) => ({ key: text(one.key), name: text(one.name) }))
		.filter((one) => /^[\w-]+$/.test(one.key));
}

/** A server's libraries, or what is inside one of them; undefined where the server did not answer. */
export async function browseMedia(server: string, parent?: string): Promise<MediaItem[] | undefined> {
	const found = await library(parent ? { op: "items", server, parent } : { op: "views", server });
	if (!Array.isArray(found?.items)) return undefined;
	return found.items.map(readItem).filter((one): one is MediaItem => one !== undefined);
}

export async function searchMedia(server: string, words: string): Promise<MediaItem[] | undefined> {
	const found = await library({ op: "search", server, q: words.slice(0, 100) });
	if (!Array.isArray(found?.items)) return undefined;
	return found.items.map(readItem).filter((one): one is MediaItem => one !== undefined);
}

/** What to resolve to play one item from one server. */
export function mediaLink(server: string, item: string): string {
	return `library:${server}/${item}`;
}

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
