import { describe, expect, it } from "vitest";
import { generateRoomName, looksGenerated, normaliseRoomName, validRoomName } from "./names";
import { impersonating, parseName, signatureOf } from "./name";

describe("generateRoomName", () => {
	it("produces a name the server will accept", () => {
		for (let i = 0; i < 200; i++) {
			const name = generateRoomName();
			expect(validRoomName(name), name).toBe(true);
			expect(looksGenerated(name), name).toBe(true);
		}
	});

	// The name is the credential, so repetition would be somebody walking into
	// a stranger's meeting rather than a cosmetic flaw.
	it("does not repeat itself over a large sample", () => {
		const seen = new Set(Array.from({ length: 500 }, generateRoomName));
		expect(seen.size).toBe(500);
	});
});

describe("normaliseRoomName", () => {
	it("reduces what somebody typed to something acceptable", () => {
		expect(normaliseRoomName("Weekly Standup")).toBe("weekly-standup");
		expect(normaliseRoomName("  Team!! Sync  ")).toBe("team-sync");
		expect(normaliseRoomName("--edges--")).toBe("edges");
		expect(normaliseRoomName("已经开始")).toBe("");
	});

	it("keeps the result within the length the server allows", () => {
		expect(normaliseRoomName("a".repeat(200)).length).toBeLessThanOrEqual(64);
	});

	it("leaves an acceptable name alone", () => {
		expect(normaliseRoomName("weekly-standup")).toBe("weekly-standup");
	});
});

describe("looksGenerated", () => {
	// Decides whether to warn that a room can be guessed, so a chosen name must
	// never be mistaken for one from the generator.
	it("is false for names somebody chose", () => {
		for (const name of ["standup", "team-sync", "amber-otter-glide", "amber-otter-glide-42"]) {
			expect(looksGenerated(name), name).toBe(false);
		}
	});
});

describe("parseName", () => {
	it("splits a name from its passphrase", () => {
		expect(parseName("Alice#hunter2")).toEqual({ name: "Alice", passphrase: "hunter2" });
		expect(parseName("Alice")).toEqual({ name: "Alice", passphrase: "" });
		expect(parseName("  Alice  ")).toEqual({ name: "Alice", passphrase: "" });
	});

	// A harder passphrase is a better one, so nothing in it is rejected.
	it("keeps everything after the first separator", () => {
		expect(parseName("Alice#a#b#c").passphrase).toBe("a#b#c");
	});

	it("allows a passphrase with no name", () => {
		expect(parseName("#secret")).toEqual({ name: "", passphrase: "secret" });
	});
});

// A signature is exactly ten base32 characters, and an identity carries thirty
// two hex characters of randomness after it.
const TRIP = "k7m2q6x4rt";
const HEX = "0123456789abcdef0123456789abcdef";

describe("signatureOf", () => {
	it("reads a mark that was earned", () => {
		expect(signatureOf(`t${TRIP}-${HEX}`)).toEqual({ trip: TRIP, proven: true });
	});

	// Everybody carries one. What differs is whether it proves anything, and
	// that difference is the whole mechanism: a mark nobody can tell apart from
	// an earned one would let an impostor point at theirs and claim it.
	it("reads a mark that was issued, and does not call it proven", () => {
		expect(signatureOf(`g${TRIP}-${HEX}`)).toEqual({ trip: TRIP, proven: false });
	});

	it("rejects anything that is not shaped like one", () => {
		expect(signatureOf("t-short")).toBeUndefined();
		expect(signatureOf(`tABCDEFGHIJ-${HEX}`)).toBeUndefined();
		expect(signatureOf(`t${TRIP}x${HEX}`)).toBeUndefined();
		expect(signatureOf(`x${TRIP}-${HEX}`)).toBeUndefined();
	});
});

describe("impersonating", () => {
	const signed = { name: "Alice", identity: `t${TRIP}-${HEX}` };
	const unsigned = { name: "Alice", identity: `gaaaaaaaaaa-${HEX}` };
	const other = { name: "Bob", identity: `gbbbbbbbbbb-${HEX}` };

	it("marks an unsigned participant wearing a signed name", () => {
		expect(impersonating(unsigned, [signed, unsigned, other])).toBe(true);
	});

	it("never marks the signed participant", () => {
		expect(impersonating(signed, [signed, unsigned, other])).toBe(false);
	});

	// Two people genuinely called Alex is ordinary and worth no comment.
	it("says nothing about a collision between two unsigned names", () => {
		const twin = { name: "Alice", identity: `gcccccccccc-${HEX}` };
		expect(impersonating(unsigned, [unsigned, twin])).toBe(false);
	});

	it("says nothing when nobody else is called that", () => {
		expect(impersonating(unsigned, [unsigned, other])).toBe(false);
	});
});
