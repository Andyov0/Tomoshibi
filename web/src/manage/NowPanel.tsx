import { cn } from "@/lib/utils";
import { type Now, api } from "./api";
import { usePoll } from "./poll";
import { Card, Failed } from "./Shell";
import { Trend } from "./Trend";
import { LINK_BITS, rate, since, size } from "./units";
import { t } from "@/live/i18n";

/**
 * How the server is doing, and how it got here.
 *
 * The plot is the point. A single reading says whether the link is busy now; a
 * half hour of them says whether the evening was climbing, and whether the
 * retransmissions underneath began before or after it did — which is the
 * difference between somebody's connection and this one running out.
 *
 * The reading itself is polled a floor above and handed down, because it also
 * belongs in the rail, where it is legible from every other panel.
 */
export function NowPanel({ now, onSignedOut }: { now?: Now; onSignedOut: () => void }) {
	// Sampled every five seconds on the server, so asking oftener than that
	// returns the same list with the same last element.
	const { value: history, error } = usePoll(api.history, { every: 5000, onSignedOut });

	const samples = history ?? [];
	const window = now?.bytes.window ?? 0;

	return (
		<div className="mx-auto flex max-w-5xl flex-col gap-3 sm:gap-4">
			{error && <Failed>{error}</Failed>}

			<Card
				title="Uplink"
				note={window > 0 ? `30 minutes · ${window}-second means` : "30 minutes"}
				actions={
					<span className="readout font-semibold text-base tabular-nums">
						{rate(now?.bytes.outPerSec ?? 0)}
					</span>
				}
			>
				<div className="px-1 pt-2 pb-1">
					<Trend samples={samples} />
				</div>

				<Ceiling bitsPerSecond={(now?.bytes.outPerSec ?? 0) * 8} />

				<div className="flex flex-wrap gap-x-4 gap-y-1 px-3 pb-3 sm:px-4">
					<Key colour="bg-tally" label="out" />
					<Key colour="bg-fg-muted" label="in" />
					<span className="ml-auto text-fg-muted text-[11px]">
						{samples.length > 0 ? `${samples.length} samples` : "filling"}
					</span>
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
				Rates are a mean over the window named above and totals are since this process started.
				Both are good for a trend and for how near the ceiling is, and neither is an account of
				what a month cost. The history is held in memory and starts again on restart.
			</p>
		</div>
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
