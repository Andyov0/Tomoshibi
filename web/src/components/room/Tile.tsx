import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/**
 * The shared frame every participant appears in.
 *
 * Split from its contents so the self-view, a remote camera, and a screen-share
 * placeholder all sit in an identically-sized box; the grid measures these, and
 * a tile that sized itself to its content would make the layout jump as people
 * turn their cameras on.
 */
export function Tile({
	label,
	signature,
	unverified,
	speaking,
	muted,
	children,
	className,
	onDoubleClick,
}: {
	label: string;
	/** A signature only this person can produce, when they signed their name. */
	signature?: string;
	/** Wearing a name somebody else signed, without one of their own. */
	unverified?: boolean;
	speaking?: boolean;
	muted?: boolean;
	children: ReactNode;
	className?: string;
	onDoubleClick?: () => void;
}) {
	return (
		<div
			onDoubleClick={onDoubleClick}
			className={cn(
				// `size-full` rather than relying on the parent to stretch it: a grid
				// item stretches on its own, but the focus stage and the filmstrip are
				// plain boxes, and a tile whose contents are absolutely positioned
				// collapses to zero height in those and vanishes.
				"group relative size-full overflow-hidden rounded-tile bg-surface",
				"ring-2 transition-colors duration-150",
				speaking ? "ring-speaking" : "ring-transparent",
				className,
			)}
		>
			{children}

			<div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-3 pt-8 pb-2">
				<span className="truncate font-medium text-sm text-white drop-shadow">{label}</span>

				{/* Monospaced and dimmed: it belongs to the name without being
				    read as part of it, and lining the characters up is what makes
				    two signatures comparable at a glance. */}
				{signature && (
					<span
						title="A signature only this person can produce"
						className="shrink-0 font-mono text-[11px] text-white/60 drop-shadow"
					>
						·{signature}
					</span>
				)}

				{/* Said only about somebody unsigned wearing a name that was
				    signed. Two people genuinely called Alex is ordinary; this is
				    the one shape impersonation takes. */}
				{unverified && (
					<span
						title="Somebody else signed this name; this participant did not"
						className="shrink-0 rounded bg-danger/90 px-1.5 py-px font-medium text-[10px] text-danger-fg"
					>
						unverified
					</span>
				)}

				{muted && <MutedIcon />}
			</div>
		</div>
	);
}

function MutedIcon() {
	return (
		<svg viewBox="0 0 24 24" className="size-3.5 shrink-0 text-white/80" aria-label="Muted" role="img">
			<path
				fill="currentColor"
				d="M3.3 2 2 3.3l6 6V10a4 4 0 0 0 5.7 3.6l1.5 1.5A6 6 0 0 1 6 10H4a8 8 0 0 0 7 7.9V21h2v-3.1a8 8 0 0 0 3.2-1.1l3.5 3.5 1.3-1.3zM16 10a4 4 0 0 1-.1.9l3 3A8 8 0 0 0 20 10h-2a6 6 0 0 1-.1 1.2zM12 4a2 2 0 0 1 2 2v4.2l-4-4V6a2 2 0 0 1 2-2"
			/>
		</svg>
	);
}
