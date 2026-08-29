import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePoll } from "./poll";

/*
 * An answer belongs to the question it was asked about.
 *
 * The question here is rebuilt on every render, so it is held in a ref and
 * changing it deliberately does not restart the timer — otherwise a caller who
 * forgot to memoise would send a request per render. The cost of that is what
 * this is about: when the subject changed, the answer already on screen stayed
 * there until the next tick, and it was not a stale answer to this question but
 * a correct answer to a different one.
 *
 * Clicking a second room showed the first room's people, and its history — and
 * the history is polled every twenty seconds, which is long enough to read,
 * believe and act on.
 */
describe("polling about a subject", () => {
	it("does not show the last subject's answer", async () => {
		const answers: Record<string, string> = { first: "one", second: "two" };

		const { result, rerender } = renderHook(
			({ about }: { about: string }) =>
				usePoll(() => Promise.resolve(answers[about]), { about, every: 60_000 }),
			{ initialProps: { about: "first" } },
		);

		await waitFor(() => expect(result.current.value).toBe("one"));

		await act(async () => {
			rerender({ about: "second" });
		});

		// Never "one". Not "one for a moment and then two", which is what a
		// panel showing the wrong room's people looks like from a chair.
		expect(result.current.value).not.toBe("one");

		await waitFor(() => expect(result.current.value).toBe("two"));
	});

	it("says it is waiting while it asks again", async () => {
		let answer = "one";

		const { result, rerender } = renderHook(
			({ about }: { about: string }) =>
				usePoll(() => Promise.resolve(answer), { about, every: 60_000 }),
			{ initialProps: { about: "first" } },
		);

		await waitFor(() => expect(result.current.loading).toBe(false));

		answer = "two";
		act(() => {
			rerender({ about: "second" });
		});

		// Synchronously, before the promise settles: the panel has to have
		// something to draw in the frame the click lands in, or it draws the
		// previous room.
		expect(result.current.loading).toBe(true);

		await waitFor(() => expect(result.current.value).toBe("two"));
	});
});
