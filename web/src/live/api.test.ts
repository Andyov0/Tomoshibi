import { beforeEach, describe, expect, it } from "vitest";
import { chosenRelay, rememberRelay } from "./api";

/*
The relay somebody chose, and the two screens that choose one.

Both the lobby and the device screen offer a machine, and only the lobby was
writing the answer down. So a choice made in the lobby was not shown a screen
later, and a choice made on the device screen did not survive a reload — a
person asked the same question twice and having both answers ignored, which is
the complaint this application has already been given about other fields.
*/
describe("the relay somebody chose", () => {
	beforeEach(() => sessionStorage.clear());

	it("is nothing until somebody chooses", () => {
		expect(chosenRelay()).toBe("");
	});

	it("comes back after it is written down", () => {
		rememberRelay("SG Misaka");
		expect(chosenRelay()).toBe("SG Misaka");
	});

	it("can be given up again", () => {
		rememberRelay("SG Misaka");
		rememberRelay("");

		// Empty is a choice: it means whichever measures fastest. Storing it as
		// an empty string rather than removing it would work here and would put
		// a key in storage that reads like a machine nobody can find.
		expect(chosenRelay()).toBe("");
		expect(sessionStorage.getItem("meet-live.relay")).toBeNull();
	});

	it("belongs to this sitting and not to this browser", () => {
		rememberRelay("SG Misaka");

		// Session storage, deliberately. Next week is a different network and
		// the machine that measured fastest today probably is not the one that
		// will — a stale answer here is a call held further away than it
		// needed to be, every time, until somebody notices a dropdown.
		expect(localStorage.getItem("meet-live.relay")).toBeNull();
		expect(sessionStorage.getItem("meet-live.relay")).toBe("SG Misaka");
	});
});
