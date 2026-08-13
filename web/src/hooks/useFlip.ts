import { useLayoutEffect, useRef } from "react";

/**
 * Make children move to their new places instead of appearing in them.
 *
 * Reads every child's position before the browser paints, compares it with
 * where it was last time, and plays the difference backwards: the element is
 * offset to its old position and released. The name is the usual one for this —
 * first, last, invert, play.
 *
 * Done here rather than with CSS transitions because the tiles are laid out by
 * a grid whose column count changes: their offsets are not animatable
 * properties, only their computed positions, and those are only knowable after
 * the layout has happened.
 *
 * An element that was not there last time is not moved from anywhere. It is
 * left to its own entrance, which is the caller's business.
 */
export function useFlip<T extends HTMLElement>(dependency: unknown) {
	const container = useRef<T>(null);
	const places = useRef(new Map<string, DOMRect>());

	useLayoutEffect(() => {
		const root = container.current;
		if (!root) return;

		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const seen = new Map<string, DOMRect>();

		for (const child of root.children) {
			if (!(child instanceof HTMLElement)) continue;

			const key = child.dataset.flip;
			if (!key) continue;

			const now = child.getBoundingClientRect();
			seen.set(key, now);

			const before = places.current.get(key);
			if (!before || reduced) continue;

			const dx = before.left - now.left;
			const dy = before.top - now.top;
			const sx = before.width / now.width;
			const sy = before.height / now.height;

			// A move of less than a pixel is a rounding difference, and animating
			// it costs a composite layer for something nobody can see.
			if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01) continue;

			child.animate(
				[
					{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
					{ transform: "none" },
				],
				{
					duration: 320,
					easing: "cubic-bezier(0.2, 0.9, 0.3, 1)",
					// Composited, so a room full of tiles moving at once does not
					// go through layout thirty times a second.
					composite: "replace",
				},
			);
		}

		places.current = seen;
	}, [dependency]);

	return container;
}
