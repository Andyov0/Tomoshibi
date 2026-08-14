import { cn } from "@/lib/utils";
import { CircleAlert, CircleCheck, CircleHelp } from "lucide-react";
import { type Check, api } from "./api";
import { usePoll } from "./poll";
import { Card, Failed } from "./Shell";

/**
 * The things that have gone quietly wrong before.
 *
 * Every check here is a fault this deployment actually had, and each was
 * expensive the same way: nothing crashed, nothing logged, and the symptom
 * pointed away from the cause. Speech breaking up was a socket buffer. A call
 * that never connected was an address discovered instead of configured.
 *
 * Each says what it found rather than only how it came out. A tick that has
 * gone stale is worse than no check, and being able to read what it thought it
 * was proving is the only way anybody notices.
 */
export function HealthPanel({ onSignedOut }: { onSignedOut: () => void }) {
	// Slower than the rest: none of this changes between one second and the
	// next, and a check that reads a file and binds a port is not free.
	const { value, error } = usePoll(api.health, { every: 15_000, onSignedOut });

	const checks = value ?? [];
	const wrong = checks.filter((one) => one.verdict === "warn").length;

	return (
		<div className="mx-auto max-w-4xl">
			<Card
				title="Checks"
				note={wrong === 0 ? "Nothing to see to" : `${wrong} worth seeing to`}
			>
				{error && <Failed>{error}</Failed>}

				<ul>
					{checks.map((one) => (
						<Row key={one.name} check={one} />
					))}
				</ul>
			</Card>
		</div>
	);
}

function Row({ check }: { check: Check }) {
	const Icon =
		check.verdict === "good" ? CircleCheck : check.verdict === "warn" ? CircleAlert : CircleHelp;

	return (
		<li className="flex gap-3 border-border border-b px-4 py-3 last:border-0">
			<Icon
				className={cn(
					"mt-0.5 size-4 shrink-0",
					check.verdict === "good" && "text-fg-muted",
					check.verdict === "warn" && "text-tally",
					check.verdict === "unknown" && "text-fg-muted/50",
				)}
			/>

			<div className="flex min-w-0 flex-col gap-1">
				<div className="flex flex-wrap items-baseline gap-x-3">
					<span className="text-[13px]">{check.name}</span>
					<span className="readout text-[11px] text-fg-muted">{check.found}</span>
				</div>

				{check.remedy && (
					// Printed, not offered as a button. The fix for more than one
					// of these is on the host, outside this container, and
					// reaching across that boundary is not a power a management
					// page should hold.
					<p className="rounded-md border border-border bg-surface-hi/40 px-2.5 py-1.5 text-[11.5px] text-fg-muted leading-relaxed">
						{check.remedy}
					</p>
				)}
			</div>
		</li>
	);
}
