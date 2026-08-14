import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { LINK_BITS, rate } from "./units";

/**
 * The uplink over the last half hour.
 *
 * uPlot rather than a React charting library, and the deciding figure is the
 * one it is measured against: this bundle is nineteen kilobytes, and the
 * declarative alternatives are five times that with a dozen d3 packages behind
 * them. A dependency that outweighs everything it draws for is worth noticing
 * even where, as here, it never reaches anybody in a meeting.
 *
 * Its interface is imperative, which is what the wrapper below is. The plot is
 * built once and fed afterwards: rebuilding it on every poll would throw away
 * the canvas twice a second and take the pointer's position with it.
 */
export function Trend({
	samples,
	className,
}: {
	samples: { at: string; in: number; out: number }[];
	className?: string;
}) {
	const host = useRef<HTMLDivElement>(null);
	const plot = useRef<uPlot>();

	// Held in a ref so the effect that builds the plot does not depend on the
	// data, and the effect that feeds it does not rebuild.
	const latest = useRef(samples);
	latest.current = samples;

	useEffect(() => {
		const element = host.current;
		if (!element) return;

		const made = new uPlot(options(element.clientWidth), series(latest.current), element);
		plot.current = made;

		// The width is the container's, and the container is a page somebody may
		// turn sideways. uPlot does not observe its own element.
		const observer = new ResizeObserver(([entry]) => {
			if (entry) made.setSize({ width: entry.contentRect.width, height: HEIGHT });
		});
		observer.observe(element);

		return () => {
			observer.disconnect();
			made.destroy();
			plot.current = undefined;
		};
	}, []);

	useEffect(() => {
		plot.current?.setData(series(samples));
	}, [samples]);

	return <div ref={host} className={className} />;
}

const HEIGHT = 150;

/** The three rows uPlot wants: time, then one per line. */
function series(samples: { at: string; in: number; out: number }[]): uPlot.AlignedData {
	const at = new Array<number>(samples.length);
	const out = new Array<number>(samples.length);
	const into = new Array<number>(samples.length);

	samples.forEach((sample, index) => {
		at[index] = new Date(sample.at).getTime() / 1000;
		// Bits, because that is the unit a link is sold in and the unit the
		// ceiling below is drawn from.
		out[index] = sample.out * 8;
		into[index] = sample.in * 8;
	});

	return [at, out, into];
}

function options(width: number): uPlot.Options {
	return {
		width: Math.max(width, 1),
		height: HEIGHT,
		padding: [8, 4, 0, 0],
		cursor: { y: false, points: { size: 5 } },
		legend: { show: false },
		scales: {
			// Fixed to the link rather than to whatever the data happens to
			// reach. A plot that rescales to its own maximum always looks the
			// same, and the one thing this exists to show — how near the ceiling
			// an evening came — is exactly what that normalises away.
			y: { auto: false, range: [0, LINK_BITS] },
		},
		axes: [
			{
				stroke: "#97928c",
				grid: { stroke: "#2e2c2a", width: 1 },
				ticks: { stroke: "#2e2c2a", width: 1 },
				font: "10px ui-monospace, Menlo, monospace",
				size: 28,
			},
			{
				stroke: "#97928c",
				grid: { stroke: "#2e2c2a", width: 1 },
				ticks: { show: false },
				font: "10px ui-monospace, Menlo, monospace",
				size: 46,
				values: (_, ticks) => ticks.map((bits) => (bits === 0 ? "" : rate(bits / 8))),
			},
		],
		series: [
			{},
			{
				label: "out",
				stroke: "#ffa23b",
				width: 1.6,
				fill: "rgba(255, 162, 59, 0.16)",
				points: { show: false },
			},
			{ label: "in", stroke: "#97928c", width: 1.3, points: { show: false } },
		],
	};
}
