import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePoll } from "./poll";

/*
 * How often the management pages ask the server anything.
 *
 * Both faults here were invisible from the page. The poll above the sign-in
 * screen went on asking behind it, refused every five seconds for as long as
 * the tab stayed open; and coming back to a tab asked again beside whatever the
 * timer had already sent, so two answers raced and the older could be the one
 * left on screen. Neither drew anything wrong, so what is counted is requests.
 */

afterEach(() => {
	vi.useRealTimers();
});

describe("usePoll", () => {
	it("asks nothing while it is not enabled, and starts when it is", async () => {
		const ask = vi.fn(async () => 1);

		const { rerender } = renderHook(({ enabled }) => usePoll(ask, { enabled }), {
			initialProps: { enabled: false },
		});
		await act(async () => {});
		expect(ask).not.toHaveBeenCalled();

		rerender({ enabled: true });
		await act(async () => {});
		expect(ask).toHaveBeenCalledTimes(1);
	});

	it("does not ask again while the last question is unanswered", async () => {
		let answer: (value: number) => void = () => {};
		const ask = vi.fn(
			() =>
				new Promise<number>((resolve) => {
					answer = resolve;
				}),
		);

		renderHook(() => usePoll(ask));
		expect(ask).toHaveBeenCalledTimes(1);

		// Coming back to the tab while the first question is still out.
		await act(async () => {
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(ask).toHaveBeenCalledTimes(1);

		await act(async () => answer(1));
	});
});
