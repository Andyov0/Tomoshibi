import { cn } from "@/lib/utils";
import { Maximize2, MicOff, Minimize2 } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The frame every participant appears in.
 *
 * A picture rather than a card: no border, no shadow, no rounded panel around
 * the face. The only things attached to it are the name and, while somebody is
 * talking, the tally along the bottom edge — which is the one coloured event in
 * the whole interface.
 *
 * Split from its contents so a camera, an avatar, and a share placeholder all
 * sit in an identically-sized box. The grid measures these, and a tile that
 * sized itself to its contents would make the layout jump as people turn their
 * cameras on.
 */
export function Tile({
	label,
	signature,
	unverified,
	speaking,
	muted,
	children,
	overlay,
	className,
	onSelect,
	onExpand,
	selected,
}: {
	label: string;
	/** A signature only this person can produce, when they signed their name. */
	signature?: string;
	/** Wearing a name somebody else signed, without one of their own. */
	unverified?: boolean;
	speaking?: boolean;
	muted?: boolean;
	children: ReactNode;
	/** Anything drawn over the picture, such as what this person just said. */
	overlay?: ReactNode;
	className?: string;
	/** A single click, which puts this on the stage or takes it back off. */
	onSelect?: () => void;
	/** A double click, which fills the screen with it. */
	onExpand?: () => void;
	/** Already on the stage, so a click sends it back to the grid. */
	selected?: boolean;
}) {
	const interactive = onSelect !== undefined || onExpand !== undefined;

	return (
		<div
			// A div rather than a button: a tile holds a video and its own
			// controls, and a button may contain neither. The role and the key
			// handler are what a button would have provided.
			role={interactive ? "button" : undefined}
			tabIndex={interactive ? 0 : undefined}
			aria-pressed={interactive ? selected : undefined}
			aria-label={interactive ? (selected ? "Show everybody" : `Show ${label} larger`) : undefined}
			onClick={onSelect}
			onDoubleClick={onExpand}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onSelect?.();
				}
			}}
			className={cn(
				// `size-full` rather than relying on the parent to stretch it: a
				// grid item stretches on its own, but the focus stage and the
				// filmstrip are plain boxes, and a tile whose contents are
				// absolutely positioned collapses to nothing in those.
				"group relative size-full overflow-hidden rounded-tile bg-surface",
				"tally-line",
				speaking && "is-live",
				interactive && "cursor-pointer outline-none",
				interactive && "focus-visible:ring-2 focus-visible:ring-fg/70",
				className,
			)}
		>
			{children}
			{overlay}

			{/* Over the picture rather than beside it: anything occupying layout
			    space would reflow the grid as the pointer crossed it. */}
			{interactive && (
				<div className="pointer-events-none absolute top-2 right-2 rounded-md bg-black/55 p-1.5 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
					{selected ? (
						<Minimize2 className="size-3.5 text-fg" />
					) : (
						<Maximize2 className="size-3.5 text-fg" />
					)}
				</div>
			)}

			{/* A pill rather than a gradient scrim. A scrim darkens the bottom
			    third of every picture to make a few words legible, which is a
			    lot of picture to spend on a name. */}
			<div className="pointer-events-none absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-0.75rem)] items-center gap-1.5 rounded-md bg-black/55 px-1.5 py-0.5 backdrop-blur-sm">
				<span
					className={cn(
						"truncate font-medium text-[11.5px] leading-5",
						speaking ? "text-tally" : "text-fg",
					)}
				>
					{label}
				</span>

				{signature && (
					<span
						title="A signature only this person can produce"
						className="readout shrink-0 text-[10px] text-fg-muted"
					>
						·{signature}
					</span>
				)}

				{unverified && (
					<span
						title="Somebody else signed this name; this participant did not"
						className="silk shrink-0 rounded bg-danger px-1 py-px text-[9px] text-danger-fg"
					>
						unverified
					</span>
				)}

				{muted && <MicOff className="size-3 shrink-0 text-fg-muted" />}
			</div>
		</div>
	);
}
