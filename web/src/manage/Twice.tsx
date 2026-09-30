import { Button } from "@/components/ui/button";
import { type ComponentProps, type ReactNode, useEffect, useState } from "react";

/** How long the second press is waited for before the button forgets the first. */
const WAIT = 4000;

/**
 * A button that has to be pressed twice.
 *
 * For the two things on these pages that end somebody else's meeting: closing a
 * room and removing a person. Each used to happen on one press, next to rows
 * that re-order themselves every couple of seconds as the poll comes back, so a
 * press meant for one row could land on another and there was nothing between
 * it and the call ending.
 *
 * Asked in place rather than in a dialog. A dialog takes the page away to ask
 * one question and puts the answer somewhere else; the button saying what a
 * second press will do, where the first one landed, is the same question with
 * nothing moving. It goes back on its own, so a press nobody follows up is
 * simply forgotten.
 */
export function Twice({
	confirm,
	onConfirm,
	children,
	...props
}: Omit<ComponentProps<typeof Button>, "onClick"> & {
	/** What the button says while it waits for the second press. */
	confirm: ReactNode;
	onConfirm: () => void;
}) {
	const [armed, setArmed] = useState(false);

	useEffect(() => {
		if (!armed) return;
		const timer = window.setTimeout(() => setArmed(false), WAIT);
		return () => window.clearTimeout(timer);
	}, [armed]);

	return (
		<Button
			{...props}
			onClick={() => {
				if (!armed) {
					setArmed(true);
					return;
				}
				setArmed(false);
				onConfirm();
			}}
			onBlur={() => setArmed(false)}
		>
			{armed ? confirm : children}
		</Button>
	);
}
