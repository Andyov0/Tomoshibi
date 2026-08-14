import { cn } from "@/lib/utils";
import { type Now, api } from "./api";
import { usePoll } from "./poll";
import { Card, Failed } from "./Shell";
import { Trend } from "./Trend";
import { LINK_BITS, rate, since, size } from "./units";

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

				<Card title="Since this process started" note="Counters reset on restart">
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

			<Card title="This server">
				<dl className="grid gap-x-4 gap-y-3 px-3 py-3 sm:grid-cols-2 sm:px-4 sm:py-4">
					<Figure label="Node" value={now?.node.id ?? "—"} mono />
					<Figure label="Address given to clients" value={now?.node.ip ?? "—"} mono />
				</dl>
			</Card>

			<p className="px-1 text-fg-muted text-[11.5px] leading-relaxed">
				Rates are a mean over the window named above and totals are since this process started.
				Both are good for a trend and for how near the ceiling is, and neither is an account of
				what a month cost. The history is held in memory and starts again on restart.
			</p>
		</div>
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
				aria-label="Share of the link in use"
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
