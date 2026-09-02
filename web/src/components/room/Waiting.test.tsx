import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Waiting } from "./Waiting";

/*
 * That the host does not wait for the host.
 *
 * The button on a meeting link does one of three things depending on who is
 * pressing it and whether the meeting has begun: waits, joins with the invite,
 * or — for the person who arranged it — joins outright, which is the event
 * everybody else is waiting for. The first version had two branches, not three,
 * and sent the host down the waiting path. Two browsers found it: the host
 * pressed "Start the meeting" and sat on a screen that said it was waiting for
 * the host, while the guest waited for the same.
 */

// Five minutes off, so the poll is on its quick tier: further out it asks every
// thirty seconds, and a test that advanced the clock by three would be waiting
// on a poll that had not been scheduled yet.
const meeting = (over: Record<string, unknown>) => ({
	id: "m",
	room: "standup",
	at: new Date(Date.now() + 5 * 60_000).toISOString(),
	started: false,
	ended: false,
	live: false,
	...over,
});

function answers(body: unknown) {
	vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it("joins outright for the host, which is what begins the meeting", async () => {
	answers(meeting({ mine: true }));
	const onStart = vi.fn();
	const onGo = vi.fn();

	render(<Waiting token="tok" name="Ada" onArranged={() => {}} onGo={onGo} onStart={onStart} />);

	const button = await screen.findByRole("button", { name: "Start the meeting" });
	fireEvent.click(button);

	expect(onStart).toHaveBeenCalledTimes(1);
	expect(onGo).not.toHaveBeenCalled();
	// And it did not start waiting.
	expect(screen.queryByText(/Waiting for the host/)).toBeNull();
});

it("waits for everybody else, then goes in with the invite once it has begun", async () => {
	answers(meeting({}));
	const onStart = vi.fn();
	const onGo = vi.fn();

	render(<Waiting token="tok" name="Bo" onArranged={() => {}} onGo={onGo} onStart={onStart} />);

	fireEvent.click(await screen.findByRole("button", { name: "Wait for the host" }));
	expect(await screen.findByText(/Waiting for the host/)).toBeTruthy();
	expect(onStart).not.toHaveBeenCalled();

	// The host arrives.
	answers(meeting({ started: true, invite: "inv-1" }));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(3500);
	});

	await waitFor(() => expect(onGo).toHaveBeenCalledWith("inv-1"));
});

it("is plainly Join for somebody who opened the link after it began", async () => {
	answers(meeting({ started: true, invite: "inv-2" }));
	const onGo = vi.fn();

	render(<Waiting token="tok" name="Cy" onArranged={() => {}} onGo={onGo} onStart={() => {}} />);

	fireEvent.click(await screen.findByRole("button", { name: "Join" }));
	expect(onGo).toHaveBeenCalledWith("inv-2");
});
