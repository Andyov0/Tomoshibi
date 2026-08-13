import { Button } from "@/components/ui/button";
import { useMeasure } from "@/hooks/useMeasure";
import { cn } from "@/lib/utils";
import { arrange } from "@/live/layout";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Tiles per page.
 *
 * Nine keeps a grid readable on a laptop, and caps how many video streams the
 * call asks for at once regardless of how many people joined.
 */
export const TILES_PER_PAGE = 9;

/** Space between tiles, and between the tiles and the edge. */
const GAP = 8;

/**
 * An arrangement of equally sized tiles, centred.
 *
 * The sizes come from [`arrange`](../../live/layout.ts) rather than from CSS
 * fractions, because a fraction of the container is whatever shape the container
 * is, and a 16:9 picture in a tall thin cell is mostly cropped away. Measuring
 * costs a resize observer and gives back pictures that keep their shape with
 * space around them.
 *
 * Measuring cannot loop here: the container's size decides the tiles, and the
 * tiles are absolutely sized rather than intrinsic, so they never decide the
 * container's.
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
	const [ref, size] = useMeasure();
	const layout = arrange(size, children.length, GAP);
	const paged = (pages ?? 1) > 1;

	return (
		<div className="relative h-full w-full">
			<div ref={ref} className={cn("flex h-full w-full items-center justify-center p-2", className)}>
				{layout && (
					<div
						className="grid"
						style={{
							gap: GAP,
							gridTemplateColumns: `repeat(${layout.columns}, ${layout.width}px)`,
							gridAutoRows: `${layout.height}px`,
							// The last row is short whenever the count does not
							// divide evenly, and centring it keeps the gap where
							// somebody is missing rather than off to one side.
							justifyItems: "center",
						}}
					>
						{children}
					</div>
				)}
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
