import type { ReactNode } from "react";

/**
 * One tile on the stage, the rest in a filmstrip.
 *
 * The filmstrip sits below on wide screens and scrolls horizontally, so the
 * stage keeps the height, which is what a shared screen needs. Tiles in the
 * strip are fixed-width rather than flexed so they stay a stable size to measure
 * for rendition selection as people come and go.
 */
export function FocusLayout({ stage, strip }: { stage: ReactNode; strip: ReactNode[] }) {
	return (
		<div className="flex h-full flex-col gap-2 p-2">
			<div className="min-h-0 flex-1">{stage}</div>

			{strip.length > 0 && (
				<div className="flex shrink-0 gap-2 overflow-x-auto pb-1">
					{strip.map((tile, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: the caller keys the tiles
						<div key={index} className="aspect-video h-28 shrink-0">
							{tile}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
