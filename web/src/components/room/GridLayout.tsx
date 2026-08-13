import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Tiles per page.
 *
 * Nine keeps a 3x3 grid readable on a laptop, and caps how many video streams
 * the call can ask for at once regardless of how many people joined.
 */
export const TILES_PER_PAGE = 9;

/**
 * Columns for a given tile count.
 *
 * A lookup rather than `ceil(sqrt(n))` because the square root is wrong at the
 * sizes that matter: two people should be side by side, not stacked, and six
 * read better as 3x2 than 3x3-with-a-hole.
 */
function columns(count: number): number {
	if (count <= 1) return 1;
	if (count <= 4) return 2;
	if (count <= 9) return 3;
	if (count <= 16) return 4;
	return 5;
}

/**
 * An equal-size grid of tiles.
 *
 * Sizing is pure CSS: the column count comes from the tile count and the rows
 * divide the available height. No measurement, so there is no reflow loop
 * between the grid and the tiles measuring themselves for rendition selection.
 */
export function GridLayout({
	children,
	className,
	page,
	pages,
	onNext,
	onPrevious,
}: {
	children: ReactNode[];
	className?: string;
	page?: number;
	pages?: number;
	onNext?: () => void;
	onPrevious?: () => void;
}) {
	const count = children.length;
	const paged = (pages ?? 1) > 1;

	return (
		<div className="relative h-full w-full">
			<div
				className={cn("grid h-full w-full gap-2 p-2", className)}
				style={{
					gridTemplateColumns: `repeat(${columns(count)}, minmax(0, 1fr))`,
					gridAutoRows: "minmax(0, 1fr)",
				}}
			>
				{children}
			</div>

			{paged && (
				<>
					<PageButton side="left" onClick={onPrevious} label="Previous page">
						<ChevronLeft />
					</PageButton>
					<PageButton side="right" onClick={onNext} label="Next page">
						<ChevronRight />
					</PageButton>

					<div className="-translate-x-1/2 absolute bottom-3 left-1/2 rounded-full bg-black/50 px-2.5 py-1 text-white/80 text-xs">
						{(page ?? 0) + 1} / {pages}
					</div>
				</>
			)}
		</div>
	);
}

function PageButton({
	side,
	onClick,
	label,
	children,
}: {
	side: "left" | "right";
	onClick?: () => void;
	label: string;
	children: ReactNode;
}) {
	return (
		<Button
			variant="secondary"
			size="icon"
			aria-label={label}
			onClick={onClick}
			className={cn(
				"-translate-y-1/2 absolute top-1/2 rounded-full opacity-60 hover:opacity-100",
				side === "left" ? "left-3" : "right-3",
			)}
		>
			{children}
		</Button>
	);
}
