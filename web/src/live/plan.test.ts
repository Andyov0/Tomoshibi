import { describe, expect, it } from "vitest";
import { GAP, ISLAND, planFocus, planGrid, stripCapacity } from "./plan";

const WINDOW = { width: 1600, height: 900 };

/** Everything the plan places, as one list, for checking against each other. */
function spots(plan: ReturnType<typeof planGrid>) {
	return [...plan.values()];
}

/** Do these two overlap by more than a rounding difference? */
function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a) {
	const tolerance = 0.5;
	return (
		a.x + a.width - tolerance > b.x &&
		b.x + b.width - tolerance > a.x &&
		a.y + a.height - tolerance > b.y &&
		b.y + b.height - tolerance > a.y
	);
}

function ids(count: number) {
	return Array.from({ length: count }, (_, i) => `p${i}`);
}

describe("planGrid", () => {
	it("places everybody, once", () => {
		for (const count of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
			const plan = planGrid(WINDOW, ids(count));
			expect(plan.size).toBe(count);
		}
	});

	it("never lets two pictures overlap", () => {
		for (const count of [2, 3, 4, 5, 6, 7, 8, 9]) {
			const placed = spots(planGrid(WINDOW, ids(count)));

			for (let i = 0; i < placed.length; i++) {
				for (let j = i + 1; j < placed.length; j++) {
					expect(overlaps(placed[i]!, placed[j]!)).toBe(false);
				}
			}
		}
	});

	it("keeps clear of the controls", () => {
		for (const count of [1, 2, 4, 6, 9]) {
			for (const spot of spots(planGrid(WINDOW, ids(count)))) {
				expect(spot.y + spot.height).toBeLessThanOrEqual(WINDOW.height - ISLAND / 2);
			}
		}
	});

	it("stays inside the window", () => {
		for (const count of [1, 3, 5, 8]) {
			for (const spot of spots(planGrid(WINDOW, ids(count)))) {
				expect(spot.x).toBeGreaterThanOrEqual(0);
				expect(spot.y).toBeGreaterThanOrEqual(0);
				expect(spot.x + spot.width).toBeLessThanOrEqual(WINDOW.width);
			}
		}
	});

	it("gives everybody the same size", () => {
		const placed = spots(planGrid(WINDOW, ids(7)));

		for (const spot of placed) {
			expect(spot.width).toBeCloseTo(placed[0]!.width, 5);
			expect(spot.height).toBeCloseTo(placed[0]!.height, 5);
		}
	});

	/*
	 * Only the last row is ever short. Aligned to the left it leaves its gap at
	 * one end, which reads as a mistake rather than as a room with somebody
	 * missing from it.
	 */
	it("centres a short last row", () => {
		// Five in a three-wide arrangement leaves two on the second row.
		const plan = planGrid({ width: 1200, height: 800 }, ids(5));
		const placed = [...plan.entries()].map(([, spot]) => spot);

		const rows = new Map<number, typeof placed>();
		for (const spot of placed) {
			const row = rows.get(Math.round(spot.y)) ?? [];
			row.push(spot);
			rows.set(Math.round(spot.y), row);
		}

		for (const row of rows.values()) {
			const left = Math.min(...row.map((s) => s.x));
			const right = Math.max(...row.map((s) => s.x + s.width));
			expect(left).toBeCloseTo(1200 - right, 5);
		}
	});

	it("plans nothing for an unmeasured container", () => {
		expect(planGrid({ width: 0, height: 0 }, ids(4)).size).toBe(0);
		expect(planGrid(WINDOW, []).size).toBe(0);
	});
});

describe("planFocus", () => {
	it("puts the stage above the strip, and both clear of the controls", () => {
		const plan = planFocus(WINDOW, "stage", ids(3));

		const stage = plan.get("stage");
		if (!stage) throw new Error("the stage was not placed");

		const strip = ids(3).map((id) => plan.get(id));
		for (const spot of strip) {
			if (!spot) throw new Error("somebody in the strip was not placed");
			expect(spot.y).toBeGreaterThanOrEqual(stage.y + stage.height);
			expect(spot.y + spot.height).toBeLessThanOrEqual(WINDOW.height - ISLAND + 0.5);
		}
	});

	it("gives the stage the whole height when nobody else is here", () => {
		const alone = planFocus(WINDOW, "stage", []);
		const crowded = planFocus(WINDOW, "stage", ids(3));

		expect(alone.get("stage")?.height).toBeGreaterThan(crowded.get("stage")!.height);
		expect(alone.size).toBe(1);
	});

	/*
	 * Fullscreen is the one place where nothing is reserved. The controls have
	 * stepped aside on their own, so leaving room for them would be a band of
	 * black somebody asked to be rid of.
	 */
	it("fills the screen exactly when asked to", () => {
		const plan = planFocus(WINDOW, "stage", ids(3), { fullscreen: true });

		expect(plan.size).toBe(1);
		expect(plan.get("stage")).toEqual({ x: 0, y: 0, ...WINDOW });
	});

	it("centres the strip", () => {
		const plan = planFocus(WINDOW, "stage", ids(2));
		const strip = ids(2).map((id) => plan.get(id)!);

		const left = Math.min(...strip.map((s) => s.x));
		const right = Math.max(...strip.map((s) => s.x + s.width));
		expect(left).toBeCloseTo(WINDOW.width - right, 5);
	});

	it("plans nothing for an unmeasured container", () => {
		expect(planFocus({ width: 0, height: 0 }, "stage", ids(2)).size).toBe(0);
	});
});

describe("stripCapacity", () => {
	it("fits what the width allows", () => {
		expect(stripCapacity({ width: 1600, height: 900 })).toBeGreaterThan(
			stripCapacity({ width: 800, height: 900 }),
		);
	});

	it("holds somebody even when there is no room", () => {
		// A strip that held nobody would page for ever without showing anything.
		expect(stripCapacity({ width: 10, height: 900 })).toBe(1);
	});

	it("agrees with what it plans", () => {
		const width = 900;
		const capacity = stripCapacity({ width, height: 900 });
		const plan = planFocus({ width, height: 900 }, "stage", ids(capacity));

		for (const id of ids(capacity)) {
			const spot = plan.get(id);
			if (!spot) throw new Error(`${id} was not placed`);
			expect(spot.x).toBeGreaterThanOrEqual(GAP - 0.5);
			expect(spot.x + spot.width).toBeLessThanOrEqual(width - GAP + 0.5);
		}
	});
});
