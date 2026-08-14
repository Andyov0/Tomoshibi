import { arrange } from "./layout";

/**
 * Where every picture sits, as coordinates rather than as a tree.
 *
 * The arrangement used to be expressed by which component a tile was rendered
 * inside: a grid in one mode, a stage and a filmstrip in the other. Switching
 * between them replaced one tree with the other, so React destroyed every video
 * element and built new ones — and a video element that unmounts takes its
 * subscription with it. Putting somebody on the stage therefore stopped their
 * stream, started it again, and waited for a keyframe before anything appeared.
 * That wait is the black screen.
 *
 * Positions do not have that problem. Every picture is rendered once, in one
 * place, for as long as its owner is in the room; what changes is where it is
 * and how large. Nothing unmounts, so nothing unsubscribes, and moving to the
 * stage becomes an animation rather than an interruption.
 *
 * The geometry lives here, apart from React, because it is arithmetic and
 * arithmetic can be checked.
 */

/** Space between pictures, and between a picture and the edge. */
export const GAP = 8;

/**
 * Pictures per page in the grid.
 *
 * Nine keeps a grid readable on a laptop, and caps how many streams the call
 * asks for at once however many people joined. The filmstrip has no fixed number
 * of its own — what it holds is whatever fits, which is [`stripCapacity`](#stripCapacity).
 */
export const TILES_PER_PAGE = 9;

/**
 * Height the floating controls occupy at the bottom of the window.
 *
 * Reserved so that nothing is laid out underneath them. The filmstrip used to
 * run to the bottom edge and pass beneath the island, which put whoever happened
 * to be in the middle of the strip behind a row of buttons.
 */
export const ISLAND = 68;

/** How tall a picture is in the filmstrip. */
const STRIP = 112;

/** The shape every picture keeps. */
const ASPECT = 16 / 9;

/** Somewhere for one picture to be. */
export interface Spot {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Where each picture goes, by id.
 *
 * An id that is absent is not shown at all. It is still rendered — that is the
 * point — but it is out of sight, which costs nothing: a hidden element does not
 * intersect the viewport, and a track nobody is looking at is dropped to nothing
 * by the subscription that follows visibility.
 */
export type Plan = Map<string, Spot>;

export interface Size {
	width: number;
	height: number;
}

/**
 * Lay pictures out in a grid, centred.
 *
 * Sizes come from [`arrange`](./layout.ts); this places them. The island is
 * taken out of the space an arrangement may fill but not out of the space it is
 * centred in, so a grid sits where the eye expects it rather than being pushed
 * upward with a band of nothing beneath it.
 *
 * Each row is centred on its own. Only the last row is ever short, and a short
 * row aligned to the left leaves its gap at one end, which reads as a mistake
 * rather than as a room with somebody missing from it.
 */
export function planGrid(container: Size, ids: string[]): Plan {
	const plan: Plan = new Map();

	const layout = arrange(
		{ width: container.width, height: Math.max(0, container.height - ISLAND) },
		ids.length,
		GAP,
	);
	if (!layout) return plan;

	const { columns, rows, width, height } = layout;
	const gridHeight = rows * height + (rows - 1) * GAP;
	const top = (container.height - gridHeight) / 2;

	ids.forEach((id, index) => {
		const row = Math.floor(index / columns);
		const column = index % columns;

		const inRow = row === rows - 1 ? ids.length - row * columns : columns;
		const rowWidth = inRow * width + (inRow - 1) * GAP;

		plan.set(id, {
			x: (container.width - rowWidth) / 2 + column * (width + GAP),
			y: top + row * (height + GAP),
			width,
			height,
		});
	});

	return plan;
}

/**
 * Lay one picture on a stage with the rest in a filmstrip beneath it.
 *
 * Whoever is given in `strip` is placed in it. Deciding how many that may be
 * belongs to the caller, which has to page the remainder anyway; asking
 * [`stripCapacity`](#stripCapacity) twice would be two places to get it wrong.
 */
export function planFocus(
	container: Size,
	stage: string,
	strip: string[],
	options: { fullscreen?: boolean } = {},
): Plan {
	const plan: Plan = new Map();
	if (container.width <= 0 || container.height <= 0) return plan;

	// Somebody who asked for the whole screen asked for the whole screen: no
	// padding, no strip, and nothing reserved for controls that have stepped
	// aside themselves.
	if (options.fullscreen) {
		plan.set(stage, { x: 0, y: 0, width: container.width, height: container.height });
		return plan;
	}

	const bottom = container.height - ISLAND;
	const showStrip = strip.length > 0;
	const stripTop = bottom - STRIP;

	plan.set(stage, {
		x: GAP,
		y: GAP,
		width: Math.max(0, container.width - 2 * GAP),
		height: Math.max(0, (showStrip ? stripTop - GAP : bottom) - GAP),
	});

	if (!showStrip) return plan;

	const width = STRIP * ASPECT;
	const total = strip.length * width + (strip.length - 1) * GAP;
	const left = (container.width - total) / 2;

	strip.forEach((id, index) => {
		plan.set(id, {
			x: left + index * (width + GAP),
			y: stripTop,
			width,
			height: STRIP,
		});
	});

	return plan;
}

/**
 * How many pictures the filmstrip holds at this width.
 *
 * At least one, because a strip that holds nobody would page for ever without
 * ever showing anything.
 */
export function stripCapacity(container: Size): number {
	const width = STRIP * ASPECT;
	const usable = container.width - 2 * GAP + GAP;

	return Math.max(1, Math.floor(usable / (width + GAP)));
}
