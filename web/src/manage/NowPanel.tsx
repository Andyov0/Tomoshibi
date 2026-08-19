import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLingering } from "@/hooks/useLingering";
import { t } from "@/live/i18n";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Now, type Point, api } from "./api";
import { usePoll } from "./poll";
import { Card, Failed } from "./Shell";
import { Trend } from "./Trend";
import { LINK_BITS, count, moment, rate, since, size, width } from "./units";

/**
 * How the server is doing, and how it got here.
 *
 * The plot is the point. A single reading says whether the link is busy now; an
 * hour of them says whether the evening was climbing, and whether the
 * retransmissions underneath began before or after it did — which is the
 * difference between somebody's connection and this one running out. Six months
 * of them answers the question a single evening cannot: whether this is what
 * the link has always done.
 *
 * How far back to look is a choice rather than a constant, because the spans
 * are not variations on one question. Ten minutes is somebody watching a call
 * go wrong; a month is somebody deciding whether to pay for more bandwidth.
 *
 * The live reading is polled a floor above and handed down, because it also
 * belongs in the rail, where it is legible from every other panel. The trend is
 * polled here, because it is only ever looked at here.
 */
export function NowPanel({ now, onSignedOut }: { now?: Now; onSignedOut: () => void }) {
	const [span, setSpan] = useState<Span>("1h");
	const [range, setRange] = useState<{ from: string; to: string }>();
	const [choosing, setChoosing] = useState(false);
	const [hovered, setHovered] = useState<number | null>(null);

	const ask = useCallback(
		() => api.history(span, span === "custom" ? range : undefined),
		[span, range],
	);

	// Six months of buckets do not move every five seconds. The fine spans are
	// asked for at the rate the server samples at, and the coarse ones at a rate
	// that keeps the last bucket honest without sending a hundred kilobytes of
	// half a year twelve times a minute to a page nobody is looking at.
	const brisk = span === "10m" || span === "1h";

	const {
		value: trend,
		error,
		refresh,
	} = usePoll(ask, { every: brisk ? 5_000 : 30_000, onSignedOut });

	// The poll holds its question in a ref, so that changing it does not restart
	// the timer — and the other half of that bargain is that a new question is
	// not asked until the next tick, which on a coarse span is half a minute of
	// looking at the range somebody has just left. Skipped on the first render,
	// where the poll is already about to ask.
	const asked = useRef(false);
	useEffect(() => {
		if (!asked.current) {
			asked.current = true;
			return;
		}

		void refresh();
	}, [refresh, span, range]);

	const points = trend?.points ?? [];
	const step = trend?.step ?? 5;

	// Kept so the readout has something to draw while it is leaving. The pointer
	// is already gone by then, and a readout that empties before it fades is a
	// flicker rather than an exit.
	const last = useRef<Point>();
	const point = hovered === null ? undefined : points[hovered];
	if (point) last.current = point;

	const reading = useLingering(point !== undefined, 160);
	const idle = useLingering(point === undefined, 160);

	return (
		<div className="mx-auto flex max-w-5xl flex-col gap-3 sm:gap-4">
			{error && <Failed>{error}</Failed>}

			<Card
				title="Uplink"
				note={t("one point every {step}", { step: width(step) })}
				actions={
					<span className="readout font-semibold text-base tabular-nums">
						{rate(now?.bytes.outPerSec ?? 0)}
					</span>
				}
			>
				<Spans
					span={span}
					choosing={choosing}
					onSpan={(next) => {
						setSpan(next);
						setChoosing(false);
					}}
					onChoose={() => setChoosing((open) => !open)}
				/>

				<Custom
					open={choosing}
					onShow={(chosen) => {
						setRange(chosen);
						setSpan("custom");
						setChoosing(false);
					}}
				/>

				<div className="px-1 pt-2 pb-1">
					{/*
					  * Fed rather than rebuilt when the span changes, so the range
					  * swaps under a canvas that stays where it is. Rebuilding it
					  * flashes a blank plot between one question and the next,
					  * which reads as the page having broken rather than as a
					  * different question being answered.
					  */}
					<Trend points={points} onHover={setHovered} />
				</div>

				<Ceiling bitsPerSecond={(now?.bytes.outPerSec ?? 0) * 8} />

				{/*
				  * One line, whichever of the two things is in it.
				  *
				  * The height is reserved because the alternative is a card that
				  * grows by a line whenever the pointer crosses the chart, taking
				  * everything below it on the page with it — which is worse than
				  * having no readout at all. So the two cross over in place: one
				  * leaves as the other arrives, and nothing moves.
				  */}
				<div className="relative mb-3 h-6 overflow-hidden px-3 sm:px-4">
					{idle.mounted && (
						<div
							className={cn(
								"absolute inset-x-3 inset-y-0 flex items-center gap-x-4 sm:inset-x-4",
								idle.leaving ? "animate-depart" : "animate-arrive",
							)}
						>
							<Key colour="bg-tally" label={t("out")} />
							<Key colour="bg-fg-muted" label={t("in")} />
							<Key colour="bg-tally/30" label={t("peak")} />
							<span className="ml-auto text-fg-muted text-[11px]">
								{points.length > 0
									? t("{count} points", { count: points.length })
									: t("nothing recorded")}
							</span>
						</div>
					)}

					{reading.mounted && last.current && (
						<Reading point={last.current} step={step} leaving={reading.leaving} />
					)}
				</div>
			</Card>

			<div className="grid gap-3 sm:gap-4 md:grid-cols-2">
				<Card title="Load">
					<dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-3 py-3 sm:px-4 sm:py-4">
						<Figure label="Rooms" value={String(now?.rooms ?? 0)} />
						<Figure label="People" value={String(now?.clients ?? 0)} />
						<Figure
							label="Tracks"
							value={`${now?.tracks.in ?? 0} in · ${now?.tracks.out ?? 0} out`}
						/>
						<Figure
							label="CPU"
							value={`${Math.round((now?.cpu.load ?? 0) * 100)}% of ${now?.cpu.count ?? 0}`}
							warn={(now?.cpu.load ?? 0) > 0.8}
						/>
					</dl>
				</Card>

				<Card title="Since restart">
					<dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-3 py-3 sm:px-4 sm:py-4">
						<Figure label="Running" value={now ? since(now.since) : "—"} />
						<Figure
							label="Asked for again"
							value={`${(now?.packets.nackPerSec ?? 0).toFixed(1)}/s`}
							warn={(now?.packets.nackPerSec ?? 0) > 50}
						/>
						<Figure label="Total out" value={size(now?.bytes.out ?? 0)} />
						<Figure label="Total in" value={size(now?.bytes.in ?? 0)} />
					</dl>
				</Card>
			</div>

			{/*
			  * Which machine this is, in whichever sense applies.
			  *
			  * A deployment holding its own media is one machine and says so. A
			  * control node holds none: the figures above it are a sum across its
			  * relays, and the useful thing at the foot of the page is which
			  * relays they were summed from and which of them did not answer.
			  *
			  * Written as a branch rather than as one card with blanks in it,
			  * because the earlier version was the latter and read `node.id` on a
			  * control node, where there is no node. That took the whole page to a
			  * blank screen the moment somebody opened it.
			  */}
			{now?.fleet ? <Fleet now={now} /> : <ThisServer now={now} />}

			<p className="px-1 text-fg-muted text-[11.5px] leading-relaxed">
				{t(
					"A point is the mean over its own bucket and the band behind the line is the highest single reading inside it, which is where a burst shows. Totals are since this process started. The trend outlives a restart: fine detail recently, coarser the further back it goes, out to six months.",
				)}
			</p>
		</div>
	);
}

/**
 * How far back the chart looks.
 *
 * The list is the deployment owner's, in their order: longest first, because
 * somebody who opens this to answer a question about last month starts from the
 * left. What they asked for had both "one day" and "24 hours" in it, which are
 * the same length of time, so there is one button for them rather than two that
 * do the same thing.
 *
 * The keys are the server's vocabulary and the labels are this page's. Sending
 * a number of seconds instead would put the definition of a month in two places
 * and make disagreeing about it silent.
 */
const SPANS = [
	{ key: "6mo", label: "6 months" },
	{ key: "3mo", label: "3 months" },
	{ key: "1mo", label: "1 month" },
	{ key: "1w", label: "1 week" },
	{ key: "24h", label: "24 hours" },
	{ key: "1h", label: "1 hour" },
	{ key: "10m", label: "10 minutes" },
] as const;

type Span = (typeof SPANS)[number]["key"] | "custom";

/**
 * The row of them, drawn the way the rail beside this page is drawn.
 *
 * The named spans are a radio group, because that is what they are: one of them
 * is true at a time, and a screen reader told so can say which. Custom sits
 * beside the group rather than inside it — it opens a pair of fields rather
 * than choosing anything, and a radio that is not one is worse than no role at
 * all to somebody who cannot see the row.
 */
function Spans({
	span,
	choosing,
	onSpan,
	onChoose,
}: {
	span: Span;
	choosing: boolean;
	onSpan: (span: Span) => void;
	onChoose: () => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-1 px-3 pt-3 sm:px-4">
			<div role="radiogroup" aria-label={t("How far back")} className="flex flex-wrap gap-1">
				{SPANS.map((one) => (
					<button
						key={one.key}
						type="button"
						role="radio"
						aria-checked={span === one.key}
						onClick={() => onSpan(one.key)}
						className={chip(span === one.key)}
					>
						{t(one.label)}
					</button>
				))}
			</div>

			<button
				type="button"
				aria-expanded={choosing}
				onClick={onChoose}
				className={chip(span === "custom")}
			>
				{t("Custom")}
			</button>
		</div>
	);
}

/** One of the buttons in that row, chosen or not. */
function chip(chosen: boolean): string {
	return cn(
		"rounded-md px-2 py-1 text-[11.5px] transition-colors",
		"focus-visible:outline-2 focus-visible:outline-fg focus-visible:outline-offset-1",
		chosen ? "bg-surface-hi text-fg" : "text-fg-muted hover:bg-surface-hi/60 hover:text-fg",
	);
}

/**
 * A window that has already passed.
 *
 * Every named span above ends at this instant, which is what makes them cheap
 * to say and useless for last Tuesday evening. This is the only way to ask
 * about a stretch of time that is over.
 *
 * The browser draws the pickers. A date and time field is a thing every
 * platform already has, with a keyboard behaviour, a locale and an accessibility
 * story none of which this application could reproduce and all of which it would
 * get subtly wrong — the same reason the password manager holds the passphrases.
 *
 * It is sent as an instant rather than as the text that was typed: the fields
 * are in whoever is reading's own timezone and the server keeps UTC, and a
 * range that quietly shifted by the offset between them would draw a perfectly
 * plausible chart of the wrong eight hours.
 */
function Custom({
	open,
	onShow,
}: {
	open: boolean;
	onShow: (range: { from: string; to: string }) => void;
}) {
	const { mounted, leaving } = useLingering(open, 160);

	const [from, setFrom] = useState(() => typed(new Date(Date.now() - 24 * 3600 * 1000)));
	const [to, setTo] = useState(() => typed(new Date()));

	if (!mounted) return null;

	const backwards = !(new Date(from).getTime() < new Date(to).getTime());

	return (
		<div
			className={cn(
				"flex flex-wrap items-end gap-2 px-3 pt-3 sm:px-4",
				leaving ? "animate-depart" : "animate-arrive",
			)}
		>
			<Field label={t("From")} value={from} onChange={setFrom} />
			<Field label={t("To")} value={to} onChange={setTo} />

			<Button
				variant="secondary"
				size="sm"
				disabled={backwards}
				onClick={() =>
					onShow({
						from: new Date(from).toISOString(),
						to: new Date(to).toISOString(),
					})
				}
			>
				{t("Show")}
			</Button>
		</div>
	);
}

function Field({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<label className="flex flex-col gap-1">
			<span className="text-fg-muted text-[11px]">{label}</span>
			<Input
				type="datetime-local"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				className="h-8 w-auto text-[12px]"
			/>
		</label>
	);
}

/** What a datetime-local field wants, which is local time and no zone. */
function typed(when: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");

	return (
		`${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
		`T${pad(when.getHours())}:${pad(when.getMinutes())}`
	);
}

/**
 * What the pointer is over.
 *
 * The chart was a shape and nothing else: a line with no scale a person could
 * read off it, which is most of why it was described as not doing anything. The
 * numbers are the answer, and every one of them is a figure this page already
 * shows for the present moment — the same vocabulary, at a different time.
 *
 * The peaks are said beside the means rather than instead of them, because on a
 * coarse span they are the two halves of the answer: what the hour cost, and
 * how close the worst minute of it came.
 */
function Reading({ point, step, leaving }: { point: Point; step: number; leaving: boolean }) {
	return (
		<div
			className={cn(
				"absolute inset-x-3 inset-y-0 flex flex-nowrap items-center gap-x-3 sm:inset-x-4",
				leaving ? "animate-depart" : "animate-arrive",
			)}
		>
			<span className="readout shrink-0 text-fg text-[11px] tabular-nums">
				{moment(point.at, step)}
			</span>

			<Was label={t("out")} value={rate(point.out)} peak={rate(point.outPeak)} />
			<Was label={t("in")} value={rate(point.in)} peak={rate(point.inPeak)} />
			<Was label={t("rooms")} value={count(point.rooms)} />
			<Was label={t("people")} value={count(point.clients)} />
			<Was label={t("asked for again")} value={`${point.nack.toFixed(1)}/s`} />
		</div>
	);
}

function Was({ label, value, peak }: { label: string; value: string; peak?: string }) {
	return (
		<span className="flex min-w-0 shrink items-baseline gap-1 truncate text-[11px]">
			<span className="text-fg-muted">{label}</span>
			<span className="text-fg tabular-nums">{value}</span>
			{/* The peak only where it says something the mean does not. */}
			{peak && peak !== value && (
				<span className="text-fg-muted/70 tabular-nums">
					{t("peak")} {peak}
				</span>
			)}
		</span>
	);
}

/** The machines a control node's figures were summed from. */
function Fleet({ now }: { now: Now }) {
	const nodes = now.nodes ?? [];
	const quiet = nodes.filter((one) => !one.reachable).length;

	return (
		<Card
			title="Relays"
			note={
				quiet > 0
					? `${now.answered ?? 0} of ${now.asked ?? nodes.length} answering`
					: `${nodes.length} answering`
			}
		>
			{nodes.length === 0 && (
				<p className="px-3 py-3 text-fg-muted text-sm sm:px-4">
					No relays are configured, so this node has nowhere to send a call.
				</p>
			)}

			<ul>
				{nodes.map((one) => (
					<li
						key={one.url}
						className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-border border-b px-3 py-3 last:border-0 sm:px-4"
					>
						<span className="flex items-center gap-2">
							{/*
							  * A light rather than a dot.
							  *
							  * The dot was the same grey whatever the relay was doing,
							  * which made it decoration: it took the place where a
							  * status belongs and reported nothing. This says the three
							  * things worth knowing at a glance — answering and quiet,
							  * answering and working hard, not answering — and says
							  * them in the same colours the connection light in a call
							  * uses, so one habit reads both.
							  *
							  * Amber rather than red for a relay that is busy, and red
							  * only for one that did not answer. Busy is a machine
							  * doing its job near its limit; silent is a machine that
							  * cannot do it at all.
							  */}
							<Light
								ok={one.reachable}
								busy={(one.load ?? 0) > 0.8 || (one.outPerSec ?? 0) * 8 > LINK_BITS * 0.66}
							/>
							<span className="text-fg text-sm">{one.name}</span>
						</span>

						{one.reachable ? (
							<>
								<span className="readout text-fg-muted text-[12px]">{one.ip || "—"}</span>

								<span className="ml-auto flex flex-wrap justify-end gap-x-4 gap-y-0.5 text-fg-muted text-xs tabular-nums">
									<span>{one.rooms} rooms</span>
									<span>{one.clients} people</span>
									<span>{rate(one.outPerSec ?? 0)}</span>
									<span>{Math.round((one.load ?? 0) * 100)}% cpu</span>

									{/* What this machine has actually carried, which is the
									    figure a bill is made of — and the one that was
									    missing, because a rate says how busy a relay is now
									    and nothing about what it has cost. Since its own
									    process started, which is not the same date on every
									    machine, so it is said rather than assumed. */}
									<span className="w-full text-right text-fg-muted/70 text-[11px]">
										{t("carried")} {size(one.bytesOut ?? 0)} {t("out")} ·{" "}
										{size(one.bytesIn ?? 0)} {t("in")}
										{one.startedAt ? ` · ${since(one.startedAt)}` : ""}
									</span>
								</span>
							</>
						) : (
							<span className="ml-auto max-w-full truncate text-tally text-xs">
								{one.detail || "did not answer"}
							</span>
						)}
					</li>
				))}
			</ul>
		</Card>
	);
}

/** The one machine, where this deployment is the one holding the calls. */
function ThisServer({ now }: { now?: Now }) {
	return (
		<Card title="This server">
			<dl className="grid gap-x-4 gap-y-3 px-3 py-3 sm:grid-cols-2 sm:px-4 sm:py-4">
				<Figure label="Node" value={now?.node?.id ?? "\u2014"} mono />
				<Figure label="Address given to clients" value={now?.node?.ip ?? "\u2014"} mono />
			</dl>
		</Card>
	);
}

/**
 * A relay's state, in one dot.
 *
 * Pulsing while it is working, because a still light and a busy one should not
 * look the same at a glance — and not pulsing when it is quiet, because a page
 * of things blinking at each other is a page nobody can read.
 */
function Light({ ok, busy }: { ok: boolean; busy: boolean }) {
	return (
		<span className="relative flex size-2 shrink-0 items-center justify-center">
			{ok && busy && (
				<span className="absolute inline-flex size-full animate-ping rounded-full bg-tally/60" />
			)}

			<span
				className={cn(
					"relative inline-flex size-2 rounded-full transition-colors duration-300",
					!ok ? "bg-danger" : busy ? "bg-tally" : "bg-good",
				)}
			/>
		</span>
	);
}

/**
 * How full the pipe is, as a bar under the plot.
 *
 * The plot's own scale is fixed to the link, so the bar says the same thing
 * twice — which is the point at a glance. Amber past two thirds and red past
 * nine tenths, using the two colours this interface already has: amber marks
 * what is worth looking at, red is what cannot be undone, and a call that
 * cannot be carried is the second kind.
 */
function Ceiling({ bitsPerSecond }: { bitsPerSecond: number }) {
	const share = Math.min(1, bitsPerSecond / LINK_BITS);

	return (
		<div className="px-3 pb-2 sm:px-4">
			<div
				className="h-1.5 overflow-hidden rounded-full bg-surface-hi"
				role="meter"
				aria-valuenow={Math.round(share * 100)}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-label="Link usage"
			>
				<div
					className={cn(
						"h-full rounded-full transition-[width,background-color] duration-500",
						share > 0.9 ? "bg-danger" : share > 0.66 ? "bg-tally" : "bg-fg-muted",
					)}
					style={{ width: `${Math.max(share * 100, share > 0 ? 1 : 0)}%` }}
				/>
			</div>
			<p className="mt-1 text-fg-muted text-[11px]">{Math.round(share * 100)}% of 1 Gbps</p>
		</div>
	);
}

function Key({ colour, label }: { colour: string; label: string }) {
	return (
		<span className="flex items-center gap-1.5 text-fg-muted text-[11px]">
			<span className={cn("h-0.5 w-3.5 rounded-full", colour)} />
			{label}
		</span>
	);
}

function Figure({
	label,
	value,
	warn,
	mono,
}: {
	label: string;
	value: string;
	warn?: boolean;
	mono?: boolean;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<dt className="text-fg-muted text-xs">{label}</dt>
			<dd
				className={cn(
					"truncate text-sm tabular-nums",
					mono && "readout text-[12.5px]",
					warn && "text-tally",
				)}
			>
				{value}
			</dd>
		</div>
	);
}
