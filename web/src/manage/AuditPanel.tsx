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
				note="Cleared on restart"
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
								className="flex flex-col gap-0.5 border-border border-b px-3 py-2 last:border-0 sm:px-4"
							>
								{/* Two lines rather than five columns. Fixed widths came
								    to five hundred points, which is half again what a
								    phone has to give them. When and what is one thought;
								    who and where is another. */}
								<div className="flex items-baseline gap-2 text-xs">
									<time className="readout shrink-0 text-fg-muted tabular-nums">
										{clock(entry.at)}
									</time>
									<span className={cn("truncate", entry.failed && "text-danger")}>
										{entry.action}
									</span>
									<span className="ml-auto shrink-0 text-fg-muted/60 text-[11px]">
										{day(entry.at)}
									</span>
								</div>

								<div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-[11px]">
									<span className="readout text-fg-muted">{entry.trip}</span>
									{entry.room && <span className="text-fg-muted">{entry.room}</span>}
									{entry.target && (
										<span className="readout truncate text-fg-muted/70">{entry.target}</span>
									)}
									{entry.reason && <span className="text-danger">{entry.reason}</span>}
								</div>
							</li>
						))}
					</ul>
				)}
			</Card>
		</div>
	);
}
