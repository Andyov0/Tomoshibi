import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Now } from "./api";
import { NowPanel } from "./NowPanel";

vi.mock("./poll", () => ({ usePoll: () => ({ value: [], error: undefined }) }));

/*
 * What these guard is a page that reads a field the server did not send.
 *
 * The live reading arrives in one of two shapes. A deployment holding its own
 * media describes one process and has a node identity; a control node holds no
 * media at all, describes its relays instead, and has none. The two are not
 * variations on a theme — they are answers to different questions, because the
 * things being described are different.
 *
 * This page was written for the first and deployed on the second. `node.id`,
 * read through an optional chain that guarded only the reading above it, threw
 * the moment anybody opened the panel, and a thrown render is not a missing
 * figure — it is a blank screen where the management interface used to be. The
 * sibling panel had the same fault for the same reason and was removed rather
 * than repaired.
 *
 * So both shapes are rendered here. The assertions are deliberately shallow:
 * what matters is not which words appear but that neither shape throws, because
 * throwing is the entire failure and it takes everything else with it.
 */

const common = {
	since: new Date("2026-08-17T00:00:00Z").toISOString(),
	rooms: 2,
	clients: 5,
	tracks: { in: 4, out: 9 },
	bytes: { in: 1000, out: 2000, inPerSec: 10, outPerSec: 20, window: 10 },
	packets: { nackTotal: 3, nackPerSec: 0.5 },
	cpu: { count: 4, load: 0.25 },
};

const holdingItsOwnMedia: Now = {
	...common,
	node: { id: "ND_abc123", ip: "203.0.113.10" },
};

const aControlNode: Now = {
	...common,
	fleet: true,
	asked: 2,
	answered: 1,
	nodes: [
		{
			name: "guangzhou",
			url: "wss://gz.example:39217",
			reachable: true,
			node: "ND_gz",
			ip: "198.51.100.5",
			rooms: 2,
			clients: 5,
			tracksIn: 4,
			tracksOut: 9,
			outPerSec: 20,
			inPerSec: 8,
			bytesIn: 1_000_000,
			bytesOut: 9_000_000,
			cpus: 4,
			load: 0.25,
		},
		{
			name: "tokyo",
			url: "wss://jp.example:39217",
			reachable: false,
			detail: "dial tcp: i/o timeout",
			node: "",
			ip: "",
			rooms: 0,
			clients: 0,
			tracksIn: 0,
			tracksOut: 0,
			outPerSec: 0,
			inPerSec: 0,
			bytesIn: 0,
			bytesOut: 0,
			cpus: 0,
			load: 0,
		},
	],
};

describe("NowPanel", () => {
	it("draws a deployment that holds its own media", () => {
		render(<NowPanel now={holdingItsOwnMedia} onSignedOut={vi.fn()} />);

		expect(screen.getByText("ND_abc123")).toBeDefined();
		expect(screen.getByText("203.0.113.10")).toBeDefined();
	});

	// The one that was broken. A control node sends no node identity at all.
	it("draws a control node, which has no node of its own", () => {
		render(<NowPanel now={aControlNode} onSignedOut={vi.fn()} />);

		expect(screen.getByText("guangzhou")).toBeDefined();
		expect(screen.getByText("tokyo")).toBeDefined();
	});

	// A relay holding no calls and a relay that did not answer are both zeros,
	// and the difference between quiet and down is most of why this is opened.
	it("says why a relay did not answer rather than showing it as idle", () => {
		render(<NowPanel now={aControlNode} onSignedOut={vi.fn()} />);

		expect(screen.getByText("dial tcp: i/o timeout")).toBeDefined();
		expect(screen.getByText("1 of 2 answering")).toBeDefined();
	});

	// Before the first poll comes back there is no reading at all, which is a
	// third shape and the one every panel forgets.
	it("draws before anything has been read", () => {
		expect(() => render(<NowPanel now={undefined} onSignedOut={vi.fn()} />)).not.toThrow();
	});
});
