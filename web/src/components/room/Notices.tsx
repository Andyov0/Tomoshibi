import { Toaster } from "sonner";

/**
 * Where notices appear.
 *
 * Bottom right, sharing the corner with messages from anybody who has no tile
 * to borrow. What separates the two is shape rather than position: a notice is
 * a line of dim text, a message has a face, a name, and somebody's own words.
 * Nobody has to be told which is which.
 *
 * Sonner's own styling is replaced wholesale. Its defaults are a light card
 * with its own icons and its own type scale, none of which belong in a room
 * that is deliberately this quiet.
 */
export function Notices() {
	return (
		<Toaster
			position="bottom-right"
			// Its icons are not the set the rest of the interface uses, and a
			// notice this short says everything in the words anyway.
			icons={{}}
			// Three is what fits above the island without becoming a column of
			// its own; the fourth pushes the oldest out, which is the right
			// thing to lose.
			visibleToasts={3}
			offset={16}
			gap={8}
			// The column keeps a width so text has somewhere to lay itself out;
			// each notice then shrinks to its own words inside it and hugs the
			// right edge. Letting the column itself collapse sets four words one
			// letter to a line, which is what happens when nothing has a width.
			style={{ width: "18rem", right: 16 }}
			toastOptions={{
				unstyled: true,
				classNames: {
					toast: [
						"ml-auto flex w-fit max-w-72 items-start gap-2 rounded-lg border border-border",
						"bg-surface/95 px-3 py-2 shadow-lg backdrop-blur-md",
						"font-sans text-[12.5px] text-fg leading-snug",
					].join(" "),
					title: "font-normal",
					description: "mt-0.5 text-[11.5px] text-fg-muted",
					// The one signal colour, for the one notice that says
					// somebody is about to take over the stage.
					error: "border-danger/40",
				},
			}}
		/>
	);
}
