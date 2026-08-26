import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateRoomName } from "@/live/names";
import { RoomTitle } from "./RoomTitle";

/*
 * What the screen before a call says about the name in it.
 *
 * On most deployments, nothing worth saying: the name arrives generated, anybody
 * who has it can join, and a paragraph about that under every room would only
 * teach people to stop reading paragraphs.
 *
 * Where new rooms are an administrator's to open, the same field means something
 * else entirely — it is no longer a name to keep or replace but one to be given
 * — and somebody who is not told that presses Join, is refused, and has no way
 * to tell whether they were kept out or simply mistyped. So the line has to be
 * there before the press, and it has to be the only line: two sentences under a
 * text field are one sentence read.
 */

// The answer is fetched rather than passed in, because it belongs to the
// deployment and not to any of the props above this component.
function serverSays(policy: unknown) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify(policy), { status: 200 })),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("RoomTitle", () => {
	it("says nothing about a generated name where anybody may open a room", async () => {
		serverSays({ openedBy: "anyone" });

		// Made by the generator rather than written out, so that a change to
		// the shape of a generated name cannot leave this test quietly asserting
		// the behaviour for a chosen one.
		render(<RoomTitle room={generateRoomName()} onChange={vi.fn()} />);

		// Waited for rather than asserted at once: the point is that the answer
		// arriving does not add a line, which is only observable after it has.
		await waitFor(() => expect(fetch).toHaveBeenCalled());

		expect(screen.queryByText(/administrator/i)).toBeNull();
		expect(screen.queryByText(/anyone who guesses/i)).toBeNull();
	});

	it("warns about a name somebody chose", async () => {
		serverSays({ openedBy: "anyone" });

		render(<RoomTitle room="standup" onChange={vi.fn()} />);

		await waitFor(() => expect(screen.getByText(/anyone who guesses/i)).toBeDefined());
	});

	// And it replaces that warning rather than joining it, generated or not.
	it("says who may open a room where not everybody may", async () => {
		serverSays({ openedBy: "admins" });

		render(<RoomTitle room="standup" onChange={vi.fn()} />);

		await waitFor(() => expect(screen.getByText(/only administrators/i)).toBeDefined());
		expect(screen.queryByText(/anyone who guesses/i)).toBeNull();
	});

	/*
	 * A server that will not answer leaves the page reading the way it always
	 * has. The alternative is a deployment where anybody may open a room warning
	 * that they may not, because one request failed — and the failure is
	 * invisible, so the sentence would simply be wrong with nothing to explain
	 * it. Whether a particular room opens is decided by the server either way,
	 * and this line has never been what decides it.
	 */
	it("falls back to the answer every deployment starts with", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("no server");
			}),
		);

		render(<RoomTitle room="standup" onChange={vi.fn()} />);

		await waitFor(() => expect(screen.getByText(/anyone who guesses/i)).toBeDefined());
		expect(screen.queryByText(/only administrators/i)).toBeNull();
	});
});

/*
 * And the name somebody was given rather than one they chose.
 *
 * An invitation names one room. Renaming it walks the holder to a different one
 * carrying a key for this one, which the server refuses — so the control is not
 * a choice they have, and PreJoin's own documentation of the guest case says the
 * passphrase field goes "and so does the ability to rename the room out from
 * under the invitation". Only the first half was written; this is the second.
 */
describe("a room somebody was invited to", () => {
	it("cannot be renamed", async () => {
		const changed = vi.fn();
		render(<RoomTitle room="team-standup" onChange={changed} fixed />);

		await waitFor(() => expect(screen.getByText("team-standup")).toBeTruthy());

		expect(screen.queryByLabelText("Change room")).toBeNull();

		// Not merely hidden. The name itself opens the field on every other
		// screen, so leaving it pressable would be the same control by another
		// route.
		screen.getByText("team-standup").click();

		expect(screen.queryByLabelText("Room name")).toBeNull();
		expect(changed).not.toHaveBeenCalled();
	});

	it("is still there to be copied", async () => {
		render(<RoomTitle room="team-standup" onChange={vi.fn()} fixed />);

		await waitFor(() => expect(screen.getByText("team-standup")).toBeTruthy());

		// The link is the thing this screen is for confirming, and somebody who
		// was invited is the likeliest person to pass it on.
		expect(screen.getByLabelText("Copy link")).toBeTruthy();
	});
});

describe("a room somebody chose", () => {
	it("can still be renamed", async () => {
		render(<RoomTitle room="team-standup" onChange={vi.fn()} />);

		await waitFor(() => expect(screen.getByText("team-standup")).toBeTruthy());

		expect(screen.getByLabelText("Change room")).toBeTruthy();
	});
});
