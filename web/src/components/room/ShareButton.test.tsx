import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShareButton } from "./ShareButton";

/*
 * What these guard is a question asked in the wrong place.
 *
 * The choice of what a screen is being shared for used to be a control of its
 * own: a bare pair of numbers sitting between the chat button and the device
 * menu, present whether or not anybody was sharing, and greyed out during the
 * one activity it described. It could answer neither of the questions anybody
 * asked of it — whose setting is this, and which picture does it govern —
 * because the answers were carried by its position, and its position was wrong.
 *
 * Both answers are structural now, which is exactly the kind of property that a
 * later tidying can undo without any test noticing. So what is asserted here is
 * the structure: that the choice is reachable only through the screen button,
 * and only at the moment it is needed.
 */

/** Radix opens on the pointer going down rather than on a completed click. */
function open() {
	fireEvent.pointerDown(screen.getByRole("button", { name: "Share your screen" }), {
		button: 0,
		ctrlKey: false,
	});
}

describe("ShareButton", () => {
	it("asks what the screen is for before starting one", () => {
		const onStart = vi.fn();
		render(<ShareButton sharing={false} onStart={onStart} onStop={vi.fn()} />);

		// Nothing has begun on the click that opens the question.
		open();
		expect(onStart).not.toHaveBeenCalled();

		// And every offered answer is a kind of picture rather than a number,
		// because the number is the mechanism and not the question.
		expect(screen.getByText("Sharper text")).toBeDefined();
		expect(screen.getByText("Smoother motion")).toBeDefined();
	});

	it.each([
		["Sharper text", 30],
		["Smoother motion", 60],
	] as const)("starts at the rate that suits %s", (answer, rate) => {
		const onStart = vi.fn();
		render(<ShareButton sharing={false} onStart={onStart} onStop={vi.fn()} />);

		open();
		fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(answer) }));

		// Both halves of the choice: the kind of picture, which is what was just
		// clicked, and the amount of it, which was decided beforehand and is
		// carried along rather than asked again.
		expect(onStart).toHaveBeenCalledWith(rate, "standard");
	});

	/*
	 * How much picture to send is a separate question from what kind it is, and
	 * it is answered on a different schedule: the kind changes with whatever is
	 * on screen this minute, the amount follows from a display and an upload
	 * that do not change between meetings.
	 *
	 * So it is a setting rather than a step. These guard that it stays one —
	 * that choosing it starts nothing, and that what was chosen is what the next
	 * share uses.
	 */
	it("offers an amount of picture separately from the kind", () => {
		render(<ShareButton sharing={false} onStart={vi.fn()} onStop={vi.fn()} />);

		open();

		for (const label of ["Standard", "High", "Ultra"]) {
			expect(screen.getByText(label)).toBeDefined();
		}
	});

	it("does not start a share when the quality is chosen", () => {
		const onStart = vi.fn();
		render(<ShareButton sharing={false} onStart={onStart} onStop={vi.fn()} />);

		open();
		fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Ultra/ }));

		expect(onStart).not.toHaveBeenCalled();
	});

	it("shares at the quality that was chosen", () => {
		const onStart = vi.fn();
		render(<ShareButton sharing={false} onStart={onStart} onStop={vi.fn()} />);

		open();
		fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Ultra/ }));
		fireEvent.click(screen.getByRole("menuitem", { name: /Smoother motion/ }));

		expect(onStart).toHaveBeenCalledWith(60, "ultra");
	});

	/*
	 * Stopping is not a choice. A menu here would make somebody read two options
	 * to reach the one thing they already decided to do.
	 */
	it("stops on a single click, with nothing to choose", () => {
		const onStop = vi.fn();
		render(<ShareButton sharing onStart={vi.fn()} onStop={onStop} />);

		const button = screen.getByRole("button", { name: "Stop sharing" });
		fireEvent.click(button);

		expect(onStop).toHaveBeenCalledOnce();
		expect(screen.queryByText("Sharper text")).toBeNull();
	});

	it("says which of the two states it is in", () => {
		const { rerender } = render(<ShareButton sharing={false} onStart={vi.fn()} onStop={vi.fn()} />);
		expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("false");

		rerender(<ShareButton sharing onStart={vi.fn()} onStop={vi.fn()} />);
		expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("true");
	});
});
