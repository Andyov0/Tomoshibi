import { cn } from "@/lib/utils";
import { t } from "@/live/i18n";
import { actionFailed } from "@/live/notices";
import { Ban, Loader2, Trash2, Undo2 } from "lucide-react";
import { useCallback, useState } from "react";
import { api } from "./api";
import { usePoll } from "./poll";
import { Card, Failed } from "./Shell";
import { since } from "./units";

/**
 * The people who keep coming back, and the door.
 *
 * There are no accounts here and this page does not invent any. What it lists is
 * everybody who has joined with a passphrase: the signature it produces, what
 * they last called themselves, and when. Somebody who has never set one is not
 * here — their signature is drawn from nothing and differs in every tab, so a
 * list of them would be a list of tabs, which is why the room panel and not this
 * one is where anonymous visitors are seen.
 *
 * The useful thing here is the door. Removing somebody from a room and closing a
 * room are both undone the moment they rejoin; blocking is checked at the join,
 * which is the only point at which anybody asks to come in. It does not end the
 * call they are already in — this server could not and has no business doing so
 * — and means "not again" rather than "not now".
 */
export function PeoplePanel({
	canModerate,
	onSignedOut,
}: {
	canModerate: boolean;
	onSignedOut: () => void;
}) {
	const { value, error, refresh } = usePoll(api.people, { every: 20_000, onSignedOut });

	const [busy, setBusy] = useState<string>();
	const [asking, setAsking] = useState<string>();
	const [note, setNote] = useState("");

	const act = useCallback(
		async (trip: string, run: () => Promise<unknown>) => {
			if (busy) return;

			setBusy(trip);

			try {
				await run();
				await refresh();
			} catch (err) {
				actionFailed(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(undefined);
			}
		},
		[busy, refresh],
	);

	if (error) return <Failed>{error}</Failed>;

	const people = value ?? [];
	const blocked = people.filter((one) => one.blocked).length;

	return (
		<div className="mx-auto flex max-w-4xl flex-col gap-3 sm:gap-4">
			<Card
				title="People"
				note={
					blocked > 0
						? `${people.length} · ${blocked} ${t("blocked")}`
						: `${people.length}`
				}
			>
				{people.length === 0 && (
					<p className="px-3 py-4 text-fg-muted text-sm sm:px-4">
						{t("Nobody has joined with a passphrase yet. Anonymous visitors are not listed here, because their signature is different in every tab.")}
					</p>
				)}

				<ul>
					{people.map((person) => (
						<li
							key={person.trip}
							className={cn(
								"flex flex-wrap items-center gap-x-4 gap-y-2 border-border border-b px-3 py-3 last:border-0 sm:px-4",
								person.blocked && "bg-danger/5",
							)}
						>
							<div className="flex min-w-0 flex-col gap-0.5">
								<span className="flex items-center gap-2">
									<span className="truncate text-fg text-sm">
										{person.name || t("Unnamed")}
									</span>

									{person.administrator && (
										<span className="rounded-full border border-border px-1.5 text-[10px] text-fg-muted">
											{t("administrator")}
										</span>
									)}

									{person.blocked && (
										<span className="rounded bg-danger/15 px-1.5 py-0.5 text-[10.5px] text-danger">
											{t("blocked")}
										</span>
									)}
								</span>

								<span className="readout text-fg-muted text-[12px]">{person.trip}</span>

								{person.note && (
									<span className="mt-0.5 text-fg-muted text-[11px]">{person.note}</span>
								)}
							</div>

							<div className="ml-auto flex items-center gap-3">
								<span className="text-fg-muted text-xs tabular-nums">
									{person.lastSeen ? since(person.lastSeen) : "—"}
									{person.rooms > 0 && ` · ${person.rooms}`}
								</span>

								{canModerate && !person.administrator && (
									<div className="flex items-center gap-1.5">
										{busy === person.trip && (
											<Loader2 className="size-3.5 animate-spin text-fg-muted" />
										)}

										{person.blocked ? (
											<button
												type="button"
												disabled={busy === person.trip}
												onClick={() =>
													act(person.trip, () => api.blockPerson(person.trip, false, ""))
												}
												className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] text-fg-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40"
											>
												<Undo2 className="size-3" />
												{t("Let back in")}
											</button>
										) : (
											<button
												type="button"
												disabled={busy === person.trip}
												onClick={() => {
													setAsking(person.trip);
													setNote("");
												}}
												className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] text-fg-muted hover:bg-surface-2 hover:text-danger disabled:opacity-40"
											>
												<Ban className="size-3" />
												{t("Block")}
											</button>
										)}

										<button
											type="button"
											disabled={busy === person.trip}
											onClick={() => act(person.trip, () => api.forgetPerson(person.trip))}
											aria-label={t("Forget")}
											title={t("Forget")}
											className="rounded-md border border-border p-1.5 text-fg-muted hover:bg-surface-2 hover:text-danger disabled:opacity-40"
										>
											<Trash2 className="size-3.5" />
										</button>
									</div>
								)}
							</div>

							{asking === person.trip && (
								<form
									className="flex w-full flex-wrap items-center gap-2 pt-1"
									onSubmit={(event) => {
										event.preventDefault();
										setAsking(undefined);
										void act(person.trip, () => api.blockPerson(person.trip, true, note));
									}}
								>
									{/* Asked for rather than required. Six months later the
									    question is always why, and nobody remembers. */}
									<input
										value={note}
										onChange={(event) => setNote(event.target.value)}
										placeholder={t("Why, for whoever reads this later")}
										maxLength={200}
										// biome-ignore lint/a11y/noAutofocus: the field appeared because it was asked for
										autoFocus
										className="min-w-40 flex-1 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
									/>

									<button
										type="submit"
										className="rounded-md bg-danger px-2.5 py-1.5 text-[12px] text-white hover:opacity-90"
									>
										{t("Block")}
									</button>

									<button
										type="button"
										onClick={() => setAsking(undefined)}
										className="rounded-md border border-border px-2.5 py-1.5 text-[12px] hover:bg-surface-2"
									>
										{t("Cancel")}
									</button>
								</form>
							)}
						</li>
					))}
				</ul>
			</Card>

			<p className="px-1 text-fg-muted text-[11.5px] leading-relaxed">
				{t("Blocking refuses their next join. It does not end a call they are already in, and it does not stop somebody choosing a different passphrase — what it stops is that signature, which is the only thing about a visitor this server can recognise.")}
			</p>
		</div>
	);
}
