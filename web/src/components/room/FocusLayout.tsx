import type { ReactNode, Ref } from "react";

/**
 * One tile on the stage, the rest in a filmstrip.
 *
 * The filmstrip sits below and scrolls horizontally, so the stage keeps the
 * height, which is what a shared screen needs. Tiles in the strip are
 * fixed-width rather than flexed, so they stay a stable size to measure for
 * quality selection as people come and go.
 *
 * The strip is hidden while the stage fills the screen: somebody who asked for
 * the whole screen asked for the whole screen.
 */
export function FocusLayout({
	stage,
	strip,
	controls,
	stageRef,
	fullscreen,
}: {
	stage: ReactNode;
	strip: ReactNode[];
	/** Overlaid on the stage, revealed on hover. */
	controls?: ReactNode;
	/** The element that goes fullscreen. */
	stageRef?: Ref<HTMLDivElement>;
	fullscreen?: boolean;
}) {
	return (
		<div className="flex h-full flex-col gap-2 p-2">
			<div ref={stageRef} className="group/stage relative min-h-0 flex-1 bg-bg">
				{stage}
				{controls}
			</div>

			{strip.length > 0 && !fullscreen && (
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
