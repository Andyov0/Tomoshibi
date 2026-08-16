import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShareButton } from "./ShareButton";

/*
 * What these guard is a control that offers something it cannot deliver.
 *
 * The frame rates a share can carry depend on its size: 1080p reaches 240, 1440p
 * stops at 120, 4K at 60. Offering the wrong ones does not fail loudly — the
 * encoder falls behind and the picture drifts, and nothing anywhere says why. So
 * the menu must offer exactly the rates the chosen size allows, and a rate
 * chosen at one size must not survive being carried to a smaller one.
 *
 * And the automatic setting has no frame rate at all, because it chooses one. A
 * control that appeared and did nothing would be a control somebody set and
 * believed.
 */

/**
 * Open the menu the way a keyboard does.
 *
 * A pointer would be the truer gesture, but jsdom defines no PointerEvent, so
 * React registers no listener for one and a synthesised pointerdown reaches
 * nothing — the menu simply stays shut, and the failure reads as a missing menu.
 * Enter opens it through the same handler and the same state.
 */
function open() {
	fireEvent.keyDown(screen.getByRole("button", { name: "Share your screen" }), { key: "Enter" });
}

function draw() {
	const onStart = vi.fn();
	render(<ShareButton sharing={false} onStart={onStart} onStop={vi.fn()} />);
	open();

	return onStart;
}

function pick(label: string) {
	fireEvent.click(screen.getByRole("menuitemcheckbox", { name: new RegExp(label) }));
}

function rates(): number[] {
	return screen
		.queryAllByRole("button")
		.map((one) => one.textContent ?? "")
		.filter((text) => /^\d+$/.test(text))
		.map(Number);
}

describe("ShareButton", () => {
	it("asks nothing and starts nothing on the press that opens it", () => {
		const onStart = draw();

		expect(onStart).not.toHaveBeenCalled();
		expect(screen.getByText("Automatic")).toBeDefined();
		expect(screen.getByText("4K")).toBeDefined();
	});

	it("offers only the frame rates the chosen size can carry", () => {
		draw();

		pick("1080p");
		expect(rates()).toEqual([15, 30, 60, 120, 240]);

		pick("1440p");
		expect(rates()).toEqual([15, 30, 60, 120]);

		pick("4K");
		expect(rates()).toEqual([15, 30, 60]);
	});

	// Automatic chooses the rate as well, so offering one would be offering a
	// control that does nothing.
	it("offers no frame rate at all for automatic", () => {
		draw();

		pick("1080p");
		expect(rates().length).toBeGreaterThan(0);

		pick("Automatic");
		expect(rates()).toEqual([]);
	});

	// The silent one. A rate chosen while 1080p was selected must not be sent
	// with 4K, where no encoder will keep up with it.
	it("does not carry a fast rate onto a size that cannot take it", () => {
		const onStart = draw();

		pick("1080p");
		fireEvent.click(screen.getByRole("button", { name: "240" }));

		pick("4K");
		fireEvent.click(screen.getByRole("menuitem", { name: /Share your screen/ }));

		expect(onStart).toHaveBeenCalledWith(60, "4k");
	});

	it("starts with both choices, and only when asked to", () => {
		const onStart = draw();

		pick("1440p");
		fireEvent.click(screen.getByRole("button", { name: "120" }));

		expect(onStart).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("menuitem", { name: /Share your screen/ }));
		expect(onStart).toHaveBeenCalledWith(120, "1440p");
	});

	// Stopping is not a choice, so while a share is running the button is a
	// button: opening a menu to answer a question already answered is a step
	// somebody has to read before dismissing it.
	it("is a plain button while a share is running", () => {
		const onStop = vi.fn();
		render(<ShareButton sharing onStart={vi.fn()} onStop={onStop} />);

		fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
		expect(onStop).toHaveBeenCalled();
	});
});
