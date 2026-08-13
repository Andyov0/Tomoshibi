import type { Said } from "@/live/chat";
import { cn } from "@/lib/utils";
import { Avatar } from "./Avatar";

/**
 * What somebody just said, on their own picture.
 *
 * No name and no face: the tile underneath is already labelled with both, and
 * repeating them is the same fact stated twice. Sitting above the name rather
 * than across the middle, because the middle is where the face is and covering
 * a face to quote somebody is the wrong trade.
 */
export function SaidOnTile({ said, compact }: { said: Said[]; compact?: boolean }) {
	if (said.length === 0) return null;

	return (
		<div className="pointer-events-none absolute inset-x-1.5 bottom-8 flex flex-col items-start gap-1">
			{said.map((one) =>
				compact ? (
					// A thumbnail is too small to read anything in, so a message
					// there is a dot: enough to say somebody spoke, not what about.
					<span key={one.id} className="size-1.5 rounded-full bg-tally" />
				) : (
					<span
						key={one.id}
						className={cn(
							"max-w-full rounded-md border border-white/5 bg-black/75 px-2 py-1",
							"text-[11.5px] leading-snug text-fg backdrop-blur-sm",
							// Two lines, then an ellipsis. Anything longer is a
							// paragraph, and a paragraph belongs in the panel.
							"line-clamp-2 animate-arrive",
						)}
					>
						{one.body}
					</span>
				),
			)}
		</div>
	);
}

/**
 * What somebody just said, when they are nowhere to be seen.
 *
 * Used for people on another page or hidden behind a share. This is the only
 * place a message needs a face and a name, because there is no tile to borrow
 * them from.
 */
export function SaidInCorner({ said }: { said: Said[] }) {
	if (said.length === 0) return null;

	return (
		<div className="pointer-events-none absolute right-3 bottom-3 z-20 flex flex-col items-end gap-1.5">
			{said.map((one, index) => {
				const run = index > 0 && said[index - 1]?.from === one.from;

				return (
					<div
						key={one.id}
						className={cn(
							"flex max-w-[17rem] gap-2 rounded-lg border border-border bg-surface/95 px-2.5 py-2",
							"shadow-lg backdrop-blur-md animate-arrive",
						)}
					>
						{/* A run from one person drops the face, the same rule the
						    panel uses, so both readings are the same conversation. */}
						<div className={cn("shrink-0", run && "invisible")}>
							<Avatar identity={one.from} className="w-5 min-w-5" />
						</div>

						<div className="flex min-w-0 flex-col">
							{!run && <span className="text-[11px] text-fg-muted">{one.name}</span>}
							<span className="break-words text-[12.5px] leading-snug text-fg">{one.body}</span>
						</div>
					</div>
				);
			})}
		</div>
	);
}
