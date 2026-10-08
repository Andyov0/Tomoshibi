import { afterEach, describe, expect, it, vi } from "vitest";
import { readResolved, resolveVideo, watchReady } from "./watch-api";

/*
The watch gateway's answers, read defensively.

They come from a service the client never sees, through the server, and what
they name is played and fetched by this page: so an address that is not http,
a relay that is not this server's own relay path, or a YouTube id that is not
one is refused rather than used.
*/

afterEach(() => {
	vi.unstubAllGlobals();
});

const good = {
	ticket: "Abc_def-1234567890xyz",
	title: "A film",
	duration: 213,
	cover: "https://i.example.invalid/c.jpg",
	link: "https://example.invalid/v",
	live: false,
	relay: false,
	play: { kind: "file", url: "https://cdn.example.invalid/v.mp4" },
	proxy: { kind: "file", url: "media?t=Abc_def-1234567890xyz" },
};

describe("a resolved video", () => {
	it("is read with its relay made a path on this server", () => {
		expect(readResolved(good)).toEqual({ ...good, proxy: { kind: "file", url: "/api/watch/media?t=Abc_def-1234567890xyz" } });
	});

	it("starts on the relay only when the gateway says so, and never because a field is missing", () => {
		expect(readResolved({ ...good, relay: true })?.relay).toBe(true);
		const { relay: _, ...without } = good;
		expect(readResolved(without)?.relay).toBe(false);
		expect(readResolved({ ...good, relay: "yes" })?.relay).toBe(false);
	});

	it("plays YouTube by id alone", () => {
		const found = readResolved({ ...good, play: { kind: "youtube", id: "dQw4w9WgXcQ", url: "https://x" } });
		expect(found?.play).toEqual({ kind: "youtube", id: "dQw4w9WgXcQ" });
	});

	it("is refused where it names something this page should not fetch or run", () => {
		for (const bad of [
			{ ...good, play: { kind: "file", url: "javascript:alert(1)" } },
			{ ...good, play: { kind: "file", url: "//evil.example.invalid/v.mp4" } },
			{ ...good, play: { kind: "youtube", id: "../../x" } },
			{ ...good, play: { kind: "flash", url: "https://x" } },
			{ ...good, proxy: { kind: "file", url: "https://evil.example.invalid/media?t=x" } },
			{ ...good, proxy: { kind: "file", url: "../admin?t=x" } },
			{ ...good, proxy: { kind: "file", url: "media?t=x&url=https://evil" } },
			{ ...good, proxy: { kind: "file", url: "media?t=Another_ticket_1234567" } },
			{ ...good, ticket: "short" },
		]) {
			expect(readResolved(bad as Record<string, unknown>)).toBeUndefined();
		}
	});

	it("drops a cover served over plain http, which the page could not show", () => {
		expect(readResolved({ ...good, cover: "http://i.example.invalid/c.jpg" })?.cover).toBe("");
	});
});

describe("asking the gateway", () => {
	const answer = (status: number, body: unknown = {}) =>
		vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

	it("tells a link that is not a video from one that cannot be played from one that failed", async () => {
		vi.stubGlobal("fetch", answer(404, { error: "not_a_video" }));
		expect(await resolveVideo("hello")).toBe("not_a_video");
		vi.stubGlobal("fetch", answer(422, { error: "unavailable" }));
		expect(await resolveVideo("https://x")).toBe("unavailable");
		vi.stubGlobal("fetch", answer(502));
		expect(await resolveVideo("https://x")).toBe("failed");
		vi.stubGlobal("fetch", answer(200, good));
		expect(await resolveVideo("https://x")).toMatchObject({ title: "A film" });
	});

	it("reads no gateway, or nobody signed in, as not ready", async () => {
		vi.stubGlobal("fetch", answer(404));
		expect(await watchReady()).toBe(false);
		vi.stubGlobal("fetch", answer(401));
		expect(await watchReady()).toBe(false);
		vi.stubGlobal("fetch", answer(200, { ready: true }));
		expect(await watchReady()).toBe(true);
	});
});
