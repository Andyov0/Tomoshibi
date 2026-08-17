import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import { dissolve } from "@/live/host";
import { actionFailed } from "@/live/notices";
import { cn } from "@/lib/utils";
import type { Room } from "livekit-client";
import { DoorClosed, Loader2, LogOut, PhoneOff } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Leaving, and — for whoever runs the room — ending it.
 *
 * The two live together because they are the same intention arriving at
 * different scales: somebody is finished. Putting the second one in a panel
 * elsewhere meant a host who was finished pressed the red button, left, and left
 * the meeting running behind them under a name they will use again next week.
 *
 * Asked rather than done, and asked with the consequence rather than with "are
 * you sure" — a question nobody has ever answered no to by reading it. Leaving a
 * call is not destructive and would not need a question at all if it were not
 * sitting next to one that is; what the question really guards is the distance
 * between the two, which is now one line of a list.
 */
export function Leaving({
	room,
	host,
	onLeave,
}: {
	room: Room;
	/** Whether this person may end the meeting for everybody. */
	host: boolean;
	onLeave: () => void;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const { mounted, leaving } = useLingering(open, 160);

	// Escape closes it, because a dialog that can only be dismissed by choosing
	// something is a dialog somebody chooses something in by accident.
	useEffect(() => {
		if (!open) return;

		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};

		document.addEventListener("keydown", escape);

		return () => document.removeEventListener("keydown", escape);
	}, [open]);

	return (
		<>
			<button
				type="button"
				aria-label={t("Leave")}
				onClick={() => setOpen(true)}
				className={cn(
					"grid size-11 place-items-center rounded-full bg-danger text-danger-fg",
					"transition-[transform,opacity] hover:opacity-90 active:scale-95",
				)}
			>
				<PhoneOff className="size-5" />
			</button>

			{mounted && (
				<div
					className={cn(
						"fixed inset-0 z-50 grid place-items-center p-6",
						// The ground behind it, which is what makes this a decision
						// rather than another control on the bar: the room is still
						// there and is no longer where the attention is.
						"bg-black/50 backdrop-blur-[2px]",
						leaving ? "animate-fade-out" : "animate-fade-in",
					)}
					onMouseDown={(event) => {
						if (event.target === event.currentTarget) setOpen(false);
					}}
				>
					<div
						role="dialog"
						aria-modal
						className={cn(
							"flex w-full max-w-72 flex-col gap-2 rounded-2xl border border-border p-3",
							"bg-surface shadow-2xl ring-1 ring-black/40",
							leaving ? "animate-depart" : "animate-arrive",
						)}
					>
						<button
							type="button"
							disabled={busy}
							onClick={onLeave}
							className={cn(
								"flex items-center gap-3 rounded-xl px-3 py-2.5 text-left",
								"transition-colors hover:bg-surface-hi disabled:opacity-40",
							)}
						>
							<LogOut className="size-4 shrink-0 text-fg-muted" />
							<span className="flex flex-col gap-0.5">
								<span className="text-[13.5px] text-fg">{t("Leave the call")}</span>
								<span className="text-[11.5px] text-fg-muted leading-snug">
									{t("The meeting carries on without you.")}
								</span>
							</span>
						</button>

						{host && (
							<button
								type="button"
								disabled={busy}
								onClick={async () => {
									setBusy(true);

									try {
										await dissolve(room);
										// No onLeave here. The media server disconnects
										// everybody, this browser among them, and the
										// screen that follows is the one everybody else
										// sees — leaving as well would race it and
										// sometimes win, which is how one person ends a
										// meeting and is told they left it.
									} catch {
										actionFailed(t("That could not be done. Try again."));
										setBusy(false);
									}
								}}
								className={cn(
									"flex items-center gap-3 rounded-xl px-3 py-2.5 text-left",
									"transition-colors hover:bg-danger/10 disabled:opacity-40",
								)}
							>
								{busy ? (
									<Loader2 className="size-4 shrink-0 animate-spin text-danger" />
								) : (
									<DoorClosed className="size-4 shrink-0 text-danger" />
								)}
								<span className="flex flex-col gap-0.5">
									<span className="text-[13.5px] text-fg">{t("End for everybody")}</span>
									<span className="text-[11.5px] text-fg-muted leading-snug">
										{t("Everybody is disconnected and links stop working.")}
									</span>
								</span>
							</button>
						)}

						<button
							type="button"
							onClick={() => setOpen(false)}
							className="rounded-xl px-3 py-2 text-[12.5px] text-fg-muted transition-colors hover:bg-surface-hi hover:text-fg"
						>
							{t("Cancel")}
						</button>
					</div>
				</div>
			)}
		</>
	);
}
