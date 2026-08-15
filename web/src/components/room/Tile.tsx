import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import type { Signature } from "@/live/name";
import { Maximize2, MicOff, Minimize2, VolumeX } from "lucide-react";
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
	silenced,
	children,
	overlay,
	className,
	onSelect,
	onExpand,
	selected,
}: {
	label: string;
	/** The mark this person carries, and whether they earned it. */
	signature?: Signature;
	/** Wearing a name somebody else signed, without one of their own. */
	unverified?: boolean;
	speaking?: boolean;
	muted?: boolean;
	/** Turned all the way down, or stopped at the server, by whoever is looking. */
	silenced?: boolean;
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
	const t = useT();
	const interactive = onSelect !== undefined || onExpand !== undefined;

	return (
		<div
			// A div rather than a button: a tile holds a video and its own
			// controls, and a button may contain neither. The role and the key
			// handler are what a button would have provided.
			role={interactive ? "button" : undefined}
			tabIndex={interactive ? 0 : undefined}
			aria-pressed={interactive ? selected : undefined}
			aria-label={
				interactive
					? selected
						? t("Show everybody")
						: t("Show {name} larger", { name: label })
					: undefined
			}
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

				{/*
				  * Everybody carries a mark, so the two kinds have to look
				  * different or the earned one means nothing: an impostor would
				  * point at their own and claim it. An earned mark leads with a
				  * dot and sits at reading weight; an issued one is dimmer and
				  * has none, which reads as a serial number rather than as a
				  * claim about who somebody is.
				  */}
				{signature && (
					<span
						title={
							signature.proven
								? t("Only this person can use this name")
								: t("Anyone could use this name")
						}
						className={cn(
							"readout shrink-0 text-[10px]",
							signature.proven ? "text-fg-muted" : "text-fg-muted/45",
						)}
					>
						{signature.proven ? "·" : ""}
						{signature.trip}
					</span>
				)}

				{unverified && (
					<span
						title={t("Someone else has proved this name")}
						className="silk shrink-0 rounded bg-danger px-1 py-px text-[9px] text-danger-fg"
					>
						{t("unverified")}
					</span>
				)}

				{/*
			  * One mark, and the reader's own doing wins it.
			  *
			  * Both say the same thing — there is no sound from here — and the
			  * pill has room for one. Whose decision it was is the difference
			  * that matters: a microphone somebody else turned off is nothing to
			  * act on, while a person visibly talking into silence is a question
			  * that has cost people ten minutes before now. The answer belongs on
			  * the picture they are looking at.
			  */}
			{silenced ? (
				<VolumeX
					className="size-3 shrink-0 text-danger"
					aria-label={t("Muted by you")}
				/>
			) : (
				muted && <MicOff className="size-3 shrink-0 text-fg-muted" />
			)}
			</div>
		</div>
	);
}
