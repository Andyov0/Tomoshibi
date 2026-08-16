/**
 * What these guard: measuring the relays is an optimisation, and an
 * optimisation that can stop a call from happening is worse than no
 * optimisation at all.
 *
 * Every failure below — an endpoint that is not there, a relay that never
 * answers, a body that is not what it should be — has to end with a join that
 * proceeds without a preference. The server falls back to keeping the room
 * together, which is a working call on a possibly worse route, and that is the
 * right end for anything that went wrong out here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fastest, forget, preferred, relays } from "./relays";

const sh = { name: "shanghai", url: "wss://sh.example.com" };
const hk = { name: "hongkong", url: "wss://hk.example.com" };
const jp = { name: "tokyo", url: "wss://jp.example.com" };

beforeEach(() => {
	forget();
	vi.restoreAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** A fetch that answers /api/relays with a list, and each relay after a delay. */
function serve(list: unknown, measure: boolean, delays: Record<string, number>) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string) => {
			if (input === "/api/relays") {
				return new Response(JSON.stringify({ relays: list, measure }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}

			const host = new URL(input).host;
			const delay = delays[host];

			// Undefined means this relay does not answer at all.
			if (delay === undefined) throw new Error("unreachable");

			await new Promise((resolve) => setTimeout(resolve, delay));
			return new Response(null, { status: 204 });
		}),
	);
}

describe("relays", () => {
	it("reports what the control node offers", async () => {
		serve([sh, hk], true, {});

		const offered = await relays();

		expect(offered.measure).toBe(true);
		expect(offered.relays.map((relay) => relay.name)).toEqual(["shanghai", "hongkong"]);
	});

	it("treats a missing endpoint as nothing to choose", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not found", { status: 404 })),
		);

		expect(await relays()).toEqual({ relays: [], measure: false });
	});

	it("treats an unreadable body as nothing to choose", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("<html>a proxy error page</html>", { status: 200 })),
		);

		expect(await relays()).toEqual({ relays: [], measure: false });
	});
});

describe("fastest", () => {
	it("names the relay that answered soonest", async () => {
		serve([sh, hk, jp], true, {
			"sh.example.com": 40,
			"hk.example.com": 5,
			"jp.example.com": 60,
		});

		expect(await fastest([sh, hk, jp])).toBe("hongkong");
	});

	it("skips a relay that does not answer", async () => {
		serve([sh, hk, jp], true, {
			// Shanghai is down; it would have been nearest had it been up.
			"hk.example.com": 30,
			"jp.example.com": 50,
		});

		expect(await fastest([sh, hk, jp])).toBe("hongkong");
	});

	it("names nothing when no relay answers", async () => {
		serve([sh, hk], true, {});

		expect(await fastest([sh, hk])).toBeUndefined();
	});

	it("does not measure when there is no choice", async () => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);

		expect(await fastest([sh])).toBe("shanghai");
		expect(await fastest([])).toBeUndefined();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("reuses a recent measurement rather than taking it again", async () => {
		serve([sh, hk], true, { "sh.example.com": 40, "hk.example.com": 5 });

		expect(await fastest([sh, hk])).toBe("hongkong");

		const before = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
		expect(await fastest([sh, hk])).toBe("hongkong");

		expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
	});

	// A cached name that is no longer offered must not be sent: the deployment
	// has changed its relays and the old name would be ignored by the server,
	// silently costing this client the measurement it thought it had.
	it("measures again when the cached relay is gone from the list", async () => {
		serve([sh, hk], true, { "sh.example.com": 40, "hk.example.com": 5 });
		expect(await fastest([sh, hk])).toBe("hongkong");

		serve([sh, jp], true, { "sh.example.com": 40, "jp.example.com": 5 });
		expect(await fastest([sh, jp])).toBe("tokyo");
	});
});

describe("preferred", () => {
	it("is empty when the deployment does not want a measurement", async () => {
		const fetcher = vi.fn(
			async () =>
				new Response(JSON.stringify({ relays: [sh, hk], measure: false }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetcher);

		expect(await preferred()).toBe("");
		// The list was asked for, and nothing was measured after it said no.
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("is empty when nothing answered", async () => {
		serve([sh, hk], true, {});

		expect(await preferred()).toBe("");
	});

	it("is empty when the whole thing throws", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);

		expect(await preferred()).toBe("");
	});

	it("names the fastest when there is one", async () => {
		serve([sh, hk], true, { "sh.example.com": 50, "hk.example.com": 5 });

		expect(await preferred()).toBe("hongkong");
	});
});
