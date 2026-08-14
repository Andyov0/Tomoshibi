import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "./dictionaries/en";
import { DICTIONARIES_FOR_TEST, LOCALES, LOCALE_NAMES, segments, t } from "./i18n";

/*
 * What these guard is the one failure a translated interface has that an
 * untranslated one does not: words that quietly stop agreeing with each other.
 *
 * A phrase renamed in English leaves four dictionaries pointing at nothing. A
 * placeholder translated along with the sentence around it — `{name}` becoming
 * `{名前}` — produces a label reading "Show {name} larger" with the braces
 * showing, in a language the person checking the build cannot read. Neither
 * fails a type check, neither throws, and both are invisible to whoever made
 * the change.
 */

const OTHERS = LOCALES.filter((locale) => locale !== "en");
const BASE = Object.keys(en);

/** The names inside the braces of a phrase, in order. */
function placeholders(template: string): string[] {
	return segments(template)
		.map((segment) => segment.value)
		.filter((value): value is string => value !== undefined)
		.sort();
}

describe.each(OTHERS)("%s", (locale) => {
	const dictionary = DICTIONARIES_FOR_TEST[locale] as Record<string, string>;

	it("says everything the interface can say", () => {
		const missing = BASE.filter((phrase) => !(phrase in dictionary));
		expect(missing).toEqual([]);
	});

	/*
	 * The other direction, which is the one that rots quietly: an entry for a
	 * phrase nobody says any more costs nothing at runtime and so survives every
	 * rename, until a dictionary is mostly archaeology.
	 */
	it("says nothing the interface no longer says", () => {
		const extra = Object.keys(dictionary).filter((phrase) => !BASE.includes(phrase));
		expect(extra).toEqual([]);
	});

	it("keeps every placeholder exactly as it was", () => {
		for (const [phrase, translated] of Object.entries(dictionary)) {
			expect(placeholders(translated), phrase).toEqual(placeholders(phrase));
		}
	});

	it("actually translates, rather than repeating the English", () => {
		// Proper nouns and single words can legitimately match. A dictionary that
		// matched throughout would be a file somebody created and never filled.
		const same = Object.entries(dictionary).filter(([phrase, value]) => phrase === value);
		expect(same.length).toBeLessThan(BASE.length / 4);
	});
});

describe("the vocabulary", () => {
	it("is used by name, so that nothing is said off the record", () => {
		// Every phrase reached through `t` is checked against this list by the
		// compiler. What cannot be checked is a component that skipped `t` and
		// wrote the words inline, which is what this looks for.
		const root = join(import.meta.dirname, "..");
		const suspicious: string[] = [];

		// The management pages are English and stay English, so their labels are
		// written where they are read. Their audience is whoever runs the
		// deployment — the same person the startup log is for — and most of what
		// they say is technical nouns, which a half-translated page renders
		// worse than an untranslated one.
		const untranslated = "manage";

		const walk = (directory: string) => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);

				if (entry.isDirectory()) {
					if (entry.name !== untranslated) walk(path);
					continue;
				}
				if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) continue;

				for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
					// A label given as a bare string, which is how every one of
					// these looked before they were collected into a dictionary.
					const bare = /(aria-label|placeholder|title)="[A-Z]/.test(line);
					if (bare) suspicious.push(`${entry.name}:${index + 1}`);
				}
			}
		};

		walk(root);
		expect(suspicious).toEqual([]);
	});

	it("names each language in itself", () => {
		// The one list read by somebody who cannot read the language it is
		// currently displayed in.
		for (const locale of LOCALES) {
			expect(LOCALE_NAMES[locale]).toBeTruthy();
		}
		expect(LOCALE_NAMES.ja).not.toMatch(/[A-Za-z]/);
		expect(LOCALE_NAMES["zh-Hant"]).not.toMatch(/[A-Za-z]/);
	});
});

describe("t", () => {
	it("falls back to a whole sentence rather than a key", () => {
		// English is the key, so an untranslated phrase reads as English rather
		// than as a dotted path somebody has to go and look up.
		expect(t("Ready to join?")).toBe("Ready to join?");
	});

	it("puts values where the phrase asks for them", () => {
		expect(t("Show {name} larger", { name: "Ada" })).toBe("Show Ada larger");
		expect(t("Device {number}", { number: 2 })).toBe("Device 2");
	});

	it("leaves a phrase alone when it carries nothing", () => {
		expect(t("Leave")).toBe("Leave");
	});
});

describe("segments", () => {
	it("cuts a phrase at its placeholders and keeps the rest", () => {
		const parts = segments("Joining as {name} with a signature");

		expect(parts.map((part) => part.value)).toEqual([undefined, "name", undefined]);
		expect(parts.map((part) => part.text).join("")).toBe("Joining as {name} with a signature");
	});

	it("handles a phrase that begins or ends with a value", () => {
		expect(segments("{name} joined").map((part) => part.value)).toEqual(["name", undefined]);
		expect(segments("Could not join {room}").map((part) => part.value)).toEqual([
			undefined,
			"room",
		]);
	});
});
