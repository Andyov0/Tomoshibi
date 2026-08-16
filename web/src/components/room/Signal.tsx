import { cn } from "@/lib/utils";
import { useT } from "@/hooks/useT";
import type { Grade, Reading } from "@/live/connection";
import { useState } from "react";

/**
 * How the call is going, in the corner.
 *
 * Two readings of the same thing, and which one somebody wants depends entirely
 * on why they looked. Most of the time the question is "is it me?", and the
 * answer is a colour and a number: bars and a round trip, small enough to
 * ignore. Occasionally the question is "what exactly is wrong?", and then
 * nothing short of the figures will do.
 *
 * So it is one control with two sizes rather than two features. Pressing it
 * opens the detail, and the choice is remembered — somebody who wants the
 * numbers usually wants them in every call, and somebody who does not never
 * wants to be asked again.
 *
 * Deliberately not a warning. It does not appear when things go wrong and
 * disappear when they are fine, because a light that only shows up in trouble
 * is one nobody can find when they need it, and its absence gets read as
 * "nothing is being measured" rather than "everything is well".
 */
export function Signal({ reading }: { reading: Reading }) {
	const t = useT();
	const [open, setOpen] = useState(() => remembered());

	const title =
		reading.grade === "lost"
			? t("Connection lost")
			: reading.grade === "poor"
				? t("Poor connection")
				: reading.grade === "fair"
					? t("Fair connection")
					: t("Good connection");

	return (
		<div className="pointer-events-auto">
			<button
				type="button"
				aria-label={title}
				title={title}
				onClick={() => {
					const next = !open;
					setOpen(next);
					remember(next);
				}}
				className={cn(
					"flex items-center gap-2 rounded-full bg-surface-hi/90 px-2.5 py-1.5 shadow backdrop-blur",
					"text-xs transition-colors hover:bg-surface-hi",
				)}
			>
				<Bars grade={reading.grade} />

				{/* The number beside the bars, because the bars alone cannot tell a
				    call that is merely far from one that is breaking. */}
				<span className="readout tabular-nums text-fg-muted">
					{reading.rttMs === undefined ? "—" : `${reading.rttMs} ms`}
				</span>
			</button>

			{open && <Detail reading={reading} />}
		</div>
	);
}

/**
 * Three bars, as a phone draws them.
 *
 * The shape is borrowed on purpose: everybody already reads it, and a legend is
 * a thing nobody looks at twice. Colour and height say the same thing twice,
 * which is what keeps it legible to somebody who cannot tell the colours apart.
 */
function Bars({ grade }: { grade: Grade }) {
	const lit = grade === "good" ? 3 : grade === "fair" ? 2 : grade === "poor" ? 1 : 0;

	const colour =
		grade === "good"
			? "bg-good"
			: grade === "fair"
				? "bg-tally"
				: "bg-danger";

	return (
		<span className="flex items-end gap-[2px]" aria-hidden="true">
			{[0, 1, 2].map((index) => (
				<span
					key={index}
					className={cn(
						"w-[3px] rounded-[1px] transition-colors",
						index === 0 && "h-1.5",
						index === 1 && "h-2.5",
						index === 2 && "h-3.5",
						index < lit ? colour : "bg-fg-muted/30",
					)}
				/>
			))}
		</span>
	);
}

/** Everything the browser knows, for when the bars are not enough. */
function Detail({ reading }: { reading: Reading }) {
	const t = useT();

	return (
		<dl className="mt-1.5 flex flex-col gap-1 rounded-lg bg-surface-hi/90 px-3 py-2 text-[11px] shadow backdrop-blur">
			<Figure
				label={t("Round trip")}
				value={reading.rttMs === undefined ? "—" : `${reading.rttMs} ms`}
			/>
			<Figure
				label={t("Lost")}
				value={reading.lossPercent === undefined ? "—" : `${reading.lossPercent.toFixed(1)}%`}
				warn={(reading.lossPercent ?? 0) > 2}
			/>
			<Figure
				label={t("Jitter")}
				value={reading.jitterMs === undefined ? "—" : `${reading.jitterMs} ms`}
			/>
			<Figure label={t("Sending")} value={rate(reading.upKbps)} />
			<Figure label={t("Receiving")} value={rate(reading.downKbps)} />

			{!reading.measured && (
				<span className="pt-0.5 text-fg-muted">{t("Measuring…")}</span>
			)}
		</dl>
	);
}

function Figure({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
	return (
		<div className="flex items-baseline justify-between gap-4">
			<dt className="text-fg-muted">{label}</dt>
			<dd className={cn("readout tabular-nums", warn ? "text-tally" : "text-fg")}>{value}</dd>
		</div>
	);
}

/**
 * A rate, in the unit that keeps it short.
 *
 * Megabits above a thousand kilobits, because a screen share reads as five
 * figures otherwise and the digits that change are the ones nobody needs.
 */
function rate(kbps: number | undefined): string {
	if (kbps === undefined) return "—";
	if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;

	return `${Math.round(kbps)} kbps`;
}

/**
 * Whether the detail was left open.
 *
 * Kept under the old product name, as every other key here is: it is what a
 * browser already has written down, and renaming one abandons it.
 */
const DETAIL_KEY = "meet-live.signal-detail";

function remembered(): boolean {
	try {
		return localStorage.getItem(DETAIL_KEY) === "open";
	} catch {
		// A browser refusing storage is a browser that shows the small one every
		// time, which is the same as never having chosen.
		return false;
	}
}

function remember(open: boolean): void {
	try {
		localStorage.setItem(DETAIL_KEY, open ? "open" : "closed");
	} catch {
		// Nothing depends on it being written down.
	}
}
