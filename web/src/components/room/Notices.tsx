import { Toaster } from "sonner";

/**
 * Where notices appear, everywhere.
 *
 * Mounted at the root of each document rather than inside the room, which is
 * where it used to be — and where it left the page before the room with no way
 * to raise anything. That page therefore grew a red bar of its own for the one
 * error it knew about, and the management pages grew a third thing again, so a
 * deployment had four ways of saying something went wrong depending on which
 * screen somebody happened to be on.
 *
 * One rule now, and it is about lifetime rather than severity:
 *
 *   A notice is something that happened. Somebody arrived, a device was
 *   refused, a room would not open. It fades, because the event is over.
 *
 *   A banner is something that is still true. The connection is down; nobody
 *   has joined yet; this browser will not give up a camera. Those stay, because
 *   dismissing them would not change the fact.
 *
 * Both belong to the corner shared with what people say. What separates a
 * notice from a message is shape rather than position: a notice is a line of
 * dim text, a message has a face, a name, and somebody's own words.
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
			// Clear of the home indicator, on the one document that is read in a
			// hand as often as at a desk.
			mobileOffset={{ bottom: "calc(env(safe-area-inset-bottom) + 1rem)", right: 12 }}
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
					// The one signal colour, for anything that went wrong.
					error: "border-danger/40",
					actionButton: [
						"ml-auto shrink-0 rounded-md bg-tally px-2 py-1",
						"font-medium text-[11.5px] text-tally-fg",
					].join(" "),
				},
			}}
		/>
	);
}
