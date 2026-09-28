import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Twice } from "./Twice";

/*
 * Closing a room and removing a person end somebody else's meeting, and each
 * happened on one press beside rows that re-order themselves as the poll comes
 * back. The second press is what stands between a slip and a call ending.
 */

afterEach(() => {
	vi.useRealTimers();
});

function button(onConfirm: () => void) {
	render(
		<Twice onConfirm={onConfirm} confirm="Press again">
			Remove
		</Twice>,
	);
	return screen.getByRole("button");
}

describe("Twice", () => {
	it("does nothing on the first press, and says what the second will do", () => {
		const onConfirm = vi.fn();
		const pressed = button(onConfirm);

		fireEvent.click(pressed);

		expect(onConfirm).not.toHaveBeenCalled();
		expect(pressed.textContent).toBe("Press again");

		fireEvent.click(pressed);
		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(pressed.textContent).toBe("Remove");
	});

	it("forgets a first press nobody followed up", () => {
		vi.useFakeTimers();
		const onConfirm = vi.fn();
		const pressed = button(onConfirm);

		fireEvent.click(pressed);
		act(() => {
			vi.advanceTimersByTime(5000);
		});
		fireEvent.click(pressed);

		expect(onConfirm).not.toHaveBeenCalled();
	});
});
