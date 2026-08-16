/**
 * What these guard is a light that says the wrong thing.
 *
 * A connection light is only useful if it can be trusted at a glance, and the
 * way it stops being trustworthy is by being kind. Three green bars on a call
 * that is breaking up does more harm than no light at all: it sends somebody
 * looking at their microphone, their browser, and their colleague before they
 * think to doubt the indicator.
 *
 * So the bands are asserted at their edges, and so is the rule that the server's
 * own verdict can only ever make the reading worse. The server sees this
 * participant from the far side; where it is unhappy and the local numbers are
 * not, the numbers are the ones missing something.
 */

import { ConnectionQuality } from "livekit-client";
import { describe, expect, it } from "vitest";

import { grade } from "./connection";

const fine = ConnectionQuality.Excellent;

describe("the connection light", () => {
	it("is green on a near, clean connection", () => {
		expect(grade(fine, 30, 0)).toBe("good");
		expect(grade(fine, 149, 1.9)).toBe("good");
	});

	// Distance alone. Nothing is being lost, and the call is still hard work.
	it("turns amber on distance before anything is lost", () => {
		expect(grade(fine, 151, 0)).toBe("fair");
		expect(grade(fine, 399, 0)).toBe("fair");
	});

	it("turns red when a conversation would stop working", () => {
		expect(grade(fine, 401, 0)).toBe("poor");
		expect(grade(fine, 20, 8.1)).toBe("poor");
	});

	// Loss matters at lower numbers than people expect: two per cent is audible.
	it("turns amber on loss a long way below what sounds like a lot", () => {
		expect(grade(fine, 20, 2.1)).toBe("fair");
	});

	// The worst of the two, not the average. A call with a perfect round trip
	// that is losing a tenth of everything is not a fair connection.
	it("takes the worse of distance and loss", () => {
		expect(grade(fine, 30, 9)).toBe("poor");
		expect(grade(fine, 500, 0)).toBe("poor");
		expect(grade(fine, 200, 3)).toBe("fair");
	});

	it("says nothing bad before anything has been measured", () => {
		expect(grade(fine, undefined, undefined)).toBe("good");
	});

	// The direction that matters. The server can pull the reading down and must
	// never push it up, or a broken call gets a clean bill of health.
	it("lets the server make it worse and never better", () => {
		expect(grade(ConnectionQuality.Poor, 20, 0)).toBe("fair");
		expect(grade(ConnectionQuality.Lost, 20, 0)).toBe("lost");

		// Already worse than the server thinks: the local numbers stand.
		expect(grade(ConnectionQuality.Excellent, 900, 20)).toBe("poor");
	});
});
