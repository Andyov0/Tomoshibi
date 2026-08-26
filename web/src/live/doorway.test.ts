import { describe, expect, it } from "vitest";
import { type Arriving, type Opening, doorway } from "./doorway";

/*
 * The order between six conditions, which is the whole of who gets in.
 *
 * These are here because the branch that matters most to any deployment with
 * settings was missing and nothing noticed. Somebody told the name of a meeting
 * — the ordinary way anybody joins anything here — was sent to a sign-in page
 * for an account they do not have, on a deployment whose own management page
 * says "everybody else can still join a room they have a link to". The server
 * would have let them in. The page never asked it.
 *
 * It went unnoticed because the decision lived inside an effect that also
 * connects to rooms, mints names and reads four kinds of storage, so exercising
 * it meant rendering the application and mocking all of that, so nobody did.
 * The lesson is in the shape of this file rather than in any one case below.
 */

function arriving(over: Partial<Arriving> = {}): Arriving {
	return { address: "", wasIn: "", account: false, opening: "anyone", ...over };
}

const settings: Opening[] = ["anyone", "signed", "admins"];

describe("an invitation", () => {
	it("wins over every other condition", () => {
		// Signed in, on a different room, on the strictest setting. None of it
		// matters: they were sent to one meeting.
		expect(
			doorway(
				arriving({
					invitation: "the-one-they-were-sent-to",
					address: "some-other-room",
					wasIn: "some-other-room",
					account: true,
					opening: "admins",
				}),
			),
		).toEqual({ at: "invited", room: "the-one-they-were-sent-to", rejoin: false });
	});
});

describe("somebody who has a room name and no account", () => {
	// The case that was missing. Written as a loop over every setting because
	// the fault was that one setting behaved differently from the others for a
	// reason that does not apply to joining.
	it.each(settings)("is let through to the join screen under %s", (opening) => {
		expect(doorway(arriving({ address: "team-standup", opening }))).toEqual({ at: "open" });
	});

	it("is not offered a guest screen, because a passphrase is the answer under signed", () => {
		const landing = doorway(arriving({ address: "team-standup", opening: "signed" }));

		// "invited" is the screen with the passphrase field removed. Removing it
		// here would remove the one thing that opens a new name.
		expect(landing.at).toBe("open");
	});

	it("still reaches the sign-in when the address names no room", () => {
		expect(doorway(arriving({ opening: "signed" }))).toEqual({ at: "sign in" });
	});
});

describe("a reload", () => {
	it("puts an account holder straight back into the call", () => {
		expect(
			doorway(arriving({ address: "standup", wasIn: "standup", account: true, opening: "signed" })),
		).toEqual({ at: "ready", rejoin: true });
	});

	// The guard is that this tab was in this room, not that somebody is signed
	// in. Signed in was the wrong test: it left everybody who arrived on an
	// invitation — who has no account by design — pressing Join after every
	// refresh.
	it("puts somebody with no account straight back in too", () => {
		expect(
			doorway(arriving({ address: "standup", wasIn: "standup", opening: "admins" })),
		).toEqual({ at: "invited", room: "standup", rejoin: true });
	});

	it("does not rejoin a room this tab was never in", () => {
		const landing = doorway(arriving({ address: "standup", wasIn: "a-different-room" }));

		expect("rejoin" in landing && landing.rejoin).toBe(false);
	});
});

describe("a bare address", () => {
	it("mints a name where anybody may open one", () => {
		expect(doorway(arriving())).toEqual({ at: "open", mint: true });
	});

	it("does not mint one over a name the address already carries", () => {
		expect(doorway(arriving({ address: "standup" }))).toEqual({ at: "open" });
	});

	it.each(["signed", "admins"] as Opening[])("shows the lobby to an account under %s", (opening) => {
		expect(doorway(arriving({ account: true, opening }))).toEqual({ at: "lobby" });
	});
});
