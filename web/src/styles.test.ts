import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * A class that does not exist is a class that does nothing, quietly.
 *
 * Every fault this file guards has the same shape and none of them could be
 * seen. A colour token that was never defined left eighty-two hover states with
 * no hover. An animation from a package that is not installed, and has never
 * been installed, left five menus cutting in and out. And the replacement for
 * that animation — this application's own, correctly named, present in the
 * stylesheet — was still dead, because Tailwind builds a variant's rule from a
 * utility declared with @utility and passes hand-written CSS through without
 * permuting it, so `data-[state=open]:animate-arrive` compiled to nothing while
 * `animate-arrive` compiled fine. Reading the source could not tell those two
 * apart. Nothing in the interface looked wrong in any of the three cases,
 * because a style that does not apply looks exactly like a style nobody wrote.
 *
 * So this reads the source rather than the rendering, which is the part a unit
 * test can honestly hold: every colour a class asks for is a token the theme
 * defines, and every animation is one this application declares in a form that
 * can carry a variant.
 */

const root = import.meta.dirname;

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);

		if (entry.isDirectory()) return sources(path);

		return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [path] : [];
	});
}

const css = readFileSync(join(root, "index.css"), "utf8");
const code = sources(root).map((path) => ({ path, text: readFileSync(path, "utf8") }));

/** The colour names the theme defines, which are the only ones that resolve. */
const defined = new Set([...css.matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1] ?? ""));

describe("every colour a class asks for", () => {
	/*
	 * Only names that extend one this theme defines, which is narrow on purpose.
	 *
	 * A wider check — every bg-, text-, border- in the source — cannot be
	 * written without a list of everything Tailwind means by those prefixes,
	 * which is sizes, alignments, sides and weights as well as colours, and a
	 * test carrying that list is one that fails whenever Tailwind grows. The
	 * fault this guards is narrower and has a shape: somebody reaches for a
	 * variation of a token that exists — surface-2 beside surface — and the
	 * class compiles to nothing, because only surface was ever declared. That is
	 * what happened, eighty-two times, and it is what this catches.
	 */
	it("is one this theme defines, and not a variation of one", () => {
		const stems = [...defined].filter((name) => !name.includes("-"));
		const prefixes =
			"bg|text|border|ring|fill|stroke|from|to|via|outline|shadow|accent|caret|divide|placeholder";
		const missing: string[] = [];

		for (const { path, text } of code) {
			for (const stem of stems) {
				for (const [, name] of text.matchAll(
					new RegExp(`\\b(?:${prefixes})-(${stem}-[a-z0-9-]+)`, "g"),
				)) {
					if (!name || defined.has(name)) continue;

					missing.push(`${path.replace(root, "")}: ${name}`);
				}
			}
		}

		expect(
			[...new Set(missing)],
			"these extend a token this theme defines and are not themselves defined, so they " +
				"compile to nothing and the style silently does not apply",
		).toEqual([]);
	});
});

describe("every animation a class asks for", () => {
	/** Declared with @utility, which is what makes a variant of it possible. */
	const utilities = new Set([...css.matchAll(/@utility\s+(animate-[a-z-]+)/g)].map((m) => m[1] ?? ""));

	it("is declared here rather than by a package that is not installed", () => {
		const foreign = code.flatMap(({ path, text }) =>
			[...text.matchAll(/\b(animate-in|animate-out|fade-in-\d|fade-out-\d|zoom-in-\d+|slide-in-from-[a-z-]+)\b/g)]
				// Named in prose, which is how the removal is explained.
				.filter((m) => !text.slice(0, m.index).endsWith("// ") && !/\/\/[^\n]*$/.test(text.slice(0, m.index).split("\n").pop() ?? ""))
				.map((m) => `${path.replace(root, "")}: ${m[1]}`),
		);

		expect(foreign, "tailwindcss-animate is not a dependency and these compile to nothing").toEqual([]);
	});

	it("is declared with @utility wherever a variant is applied to it", () => {
		const dead: string[] = [];

		for (const { path, text } of code) {
			for (const [, animation] of text.matchAll(/[a-z0-9\]]:(animate-[a-z-]+)/g)) {
				if (!animation || utilities.has(animation)) continue;

				dead.push(`${path.replace(root, "")}: ${animation}`);
			}
		}

		expect(
			dead,
			"a variant is only generated for a utility declared with @utility; a plain rule in " +
				"@layer utilities is passed through and never permuted, so this compiles to nothing",
		).toEqual([]);
	});
});

/*
That the controls, when they are down the side, have the side to themselves.

Five things float at the right of a room — the paging arrows, the reaction
bubbles, the messages card, the sound panel, and the list of who has a share
open — and every one of them was written at right-3 by somebody who did not know
the control island could be moved there. Choosing the side put the bar through
all five. Measured before the fix: the messages card ran from y 472 to 888 and
the bar from 253 to 648, so the card covered the lower half of the controls,
leaving included.

One margin fixes all five, because they are all positioned against the same
element. That is also what makes it worth a test: five components depend on one
line in a sixth, none of them mentions it, and deleting it breaks nothing that
any of them can see. The failure is a button underneath a card.
*/
describe("the controls' lane", () => {
	it("is reserved by the stage rather than by the things that would sit in it", () => {
		const room = code.find(({ path }) => path.endsWith("routes/Room.tsx"));

		expect(room, "Room.tsx has moved").toBeTruthy();

		expect(
			/aside && "mr-\[/.test(room?.text ?? ""),
			"the stage no longer gives up a margin when the controls are down the side, so " +
				"everything anchored to the right edge is drawing on top of them again",
		).toBe(true);
	});
});
