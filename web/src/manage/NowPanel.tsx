import { cn } from "@/lib/utils";
import { api } from "./api";
import { usePoll } from "./poll";
import { Card, Failed } from "./Shell";
import { LINK_BITS, rate, since, size } from "./units";

/**
 * How the server is doing, at this moment.
 *
 * The figure worth having is the one at the top: what the server is sending,
 * against what the link can carry. This deployment's ceiling is its uplink and
 * always was, and until this page there was no way to find out how near it any
 * particular evening had come.
 */
export function NowPanel({ onSignedOut }: { onSignedOut: () => void }) {
	const { value, error } = usePoll(api.now, { onSignedOut });

	return (
		<div className="mx-auto flex max-w-5xl flex-col gap-4">
			{error && <Failed>{error}</Failed>}

			<Card
				title="Sending"
				note="Against a gigabit, which is what this deployment's interface negotiates"
			>
				<div className="px-4 py-4">
					<Meter bitsPerSecond={(value?.bytes.outPerSec ?? 0) * 8} />

					<div className="mt-4 grid gap-4 sm:grid-cols-2">
						<Figure label="Out" value={rate(value?.bytes.outPerSec ?? 0)} />
						<Figure label="In" value={rate(value?.bytes.inPerSec ?? 0)} />
					</div>
				</div>
			</Card>

			<div className="grid gap-4 md:grid-cols-2">
				<Card title="Load">
					<dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-4">
						<Figure label="Rooms" value={String(value?.rooms ?? 0)} />
						<Figure label="People" value={String(value?.clients ?? 0)} />
						<Figure
							label="Tracks"
							value={`${value?.tracks.in ?? 0} in · ${value?.tracks.out ?? 0} out`}
						/>
						<Figure
							label="CPU"
							value={`${Math.round((value?.cpu.load ?? 0) * 100)}% of ${value?.cpu.count ?? 0}`}
							warn={(value?.cpu.load ?? 0) > 0.8}
						/>
					</dl>
				</Card>

				<Card title="Since this process started" note="Counters reset on restart">
					<dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-4">
						<Figure label="Running" value={value ? since(value.since) : "—"} />
						<Figure
							label="Lost packets asked for again"
							value={`${(value?.packets.nackPerSec ?? 0).toFixed(1)}/s`}
							warn={(value?.packets.nackPerSec ?? 0) > 50}
						/>
						<Figure label="Total out" value={size(value?.bytes.out ?? 0)} />
						<Figure label="Total in" value={size(value?.bytes.in ?? 0)} />
					</dl>
				</Card>
			</div>

			<Card title="This server">
				<dl className="grid gap-x-4 gap-y-3 px-4 py-4 sm:grid-cols-2">
					<Figure label="Node" value={value?.node.id ?? "—"} mono />
					<Figure label="Address given to clients" value={value?.node.ip ?? "—"} mono />
				</dl>
			</Card>

			{/* Said here rather than in a footnote, because the two figures above
			    look alike and only one of them can answer a question about a
			    month. */}
			<p className="px-1 text-fg-muted text-xs">
				Rates are a recent sample and totals are since this process started. Both are good for a
				trend and for how near the ceiling is, and neither is an account of what a month cost.
			</p>
		</div>
	);
}

/**
 * How full the pipe is.
 *
 * Amber past two thirds and red past nine tenths, using the two colours this
 * interface already has: amber marks the thing worth looking at, and red is
 * reserved for what cannot be undone. A call that cannot be carried is the
 * second kind.
 */
function Meter({ bitsPerSecond }: { bitsPerSecond: number }) {
	const share = Math.min(1, bitsPerSecond / LINK_BITS);

	return (
		<div>
			<div className="mb-2 flex items-baseline justify-between">
				<span className="readout font-medium text-2xl tabular-nums">{rate(bitsPerSecond / 8)}</span>
				<span className="text-fg-muted text-xs">{Math.round(share * 100)}% of 1 Gbps</span>
			</div>

			<div
				className="h-2 overflow-hidden rounded-full bg-surface-hi"
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
		</div>
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
		<div className="flex flex-col gap-0.5">
			<dt className="text-fg-muted text-xs">{label}</dt>
			<dd
				className={cn(
					"text-sm tabular-nums",
					mono && "readout text-[13px]",
					warn && "text-tally",
				)}
			>
				{value}
			</dd>
		</div>
	);
}
