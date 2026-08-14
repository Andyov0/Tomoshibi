import { cn } from "@/lib/utils";
import { api } from "./api";
import { usePoll } from "./poll";
import { Card, Empty, Failed } from "./Shell";
import { clock, day } from "./units";

/**
 * What administrators have done here.
 *
 * Kept by the signature that authorised each action rather than by the name
 * beside it. A name is whatever the configuration file says today; the
 * signature is what was actually proved, and it is the thing that answers who
 * removed somebody when more than one person could have.
 *
 * Refusals are here too, and they are the more useful half. A run of failed
 * sign-ins is the only sign anybody gets that somebody is trying doors.
 */
export function AuditPanel({ onSignedOut }: { onSignedOut: () => void }) {
	const { value, error } = usePoll(api.audit, { every: 5000, onSignedOut });

	const entries = value ?? [];

	return (
		<div className="mx-auto max-w-4xl">
			<Card
				title="Recent"
				note="Held in memory, and lost on restart. Every entry is also in the process log"
			>
				{error && <Failed>{error}</Failed>}

				{entries.length === 0 ? (
					<Empty>Nothing yet.</Empty>
				) : (
					<ul>
						{entries.map((entry, index) => (
							<li
								// Nothing here has an identifier of its own, and two
								// entries can legitimately be identical: the same
								// person refused twice in the same second.
								// biome-ignore lint/suspicious/noArrayIndexKey: entries are positional
								key={index}
								className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-border border-b px-4 py-2 text-xs last:border-0"
							>
								<time className="readout w-16 shrink-0 text-fg-muted tabular-nums">
									{clock(entry.at)}
								</time>

								<span className={cn("w-40 shrink-0", entry.failed && "text-danger")}>
									{entry.action}
								</span>

								<span className="readout w-28 shrink-0 text-fg-muted text-[11px]">
									{entry.trip}
								</span>

								{entry.room && <span className="text-fg-muted">{entry.room}</span>}
								{entry.target && (
									<span className="readout text-[11px] text-fg-muted">{entry.target}</span>
								)}
								{entry.reason && <span className="text-danger">{entry.reason}</span>}

								<span className="ml-auto shrink-0 text-fg-muted/60">{day(entry.at)}</span>
							</li>
						))}
					</ul>
				)}
			</Card>
		</div>
	);
}
