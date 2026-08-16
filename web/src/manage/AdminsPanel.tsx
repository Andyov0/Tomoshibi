import { cn } from "@/lib/utils";
import { t } from "@/live/i18n";
import { actionFailed } from "@/live/notices";
import { Loader2, Plus, Trash2, X } from "lucide-react";
import { useCallback, useState } from "react";
import { type Administrator, api } from "./api";
import { usePoll } from "./poll";
import { Card, Failed } from "./Shell";

/**
 * Who else may open these pages.
 *
 * Somebody is recognised here by the signature their passphrase produces, and
 * this server is never told the passphrase itself. That is what makes adding
 * somebody safe to do over a chat message: the signature is already public — it
 * prints beside its owner's name in every room they join — so the person being
 * added hands over something everybody they have ever spoken to already has.
 *
 * The list was a section of a configuration file until it was this. The reason
 * it moved is when it changes: somebody joins the team on a Tuesday, and
 * editing a file and restarting to record that would end every call the
 * deployment is holding, for a change that alters nothing about any of them.
 */
export function AdminsPanel({
	canModerate,
	onSignedOut,
}: {
	canModerate: boolean;
	onSignedOut: () => void;
}) {
	// Slowly. This list changes when somebody joins or leaves a team, which is
	// not a thing that happens while a page is open.
	const { value, error, refresh } = usePoll(api.admins, { every: 60_000, onSignedOut });

	const [adding, setAdding] = useState(false);
	const [busy, setBusy] = useState<string>();

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

	const admins = value ?? [];
	const moderators = admins.filter((one) => one.can.includes("moderate")).length;

	return (
		<div className="mx-auto flex max-w-4xl flex-col gap-3 sm:gap-4">
			<Card
				title="Administrators"
				note={
					moderators === 1
						? t("One of these can change things")
						: `${moderators} ${t("can change things")}`
				}
				actions={
					canModerate &&
					!adding && (
						<button
							type="button"
							onClick={() => setAdding(true)}
							className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-2"
						>
							<Plus className="size-3.5" />
							{t("Add somebody")}
						</button>
					)
				}
			>
				{adding && (
					<AddAdmin
						onDone={async () => {
							setAdding(false);
							await refresh();
						}}
						onCancel={() => setAdding(false)}
					/>
				)}

				<ul>
					{admins.map((one) => (
						<Row
							key={one.trip}
							admin={one}
							canModerate={canModerate}
							// The last person who can change anything cannot be removed
							// or demoted, and the server refuses it either way. Said here
							// too, so the button is not offered and then refused.
							onlyModerator={moderators === 1 && one.can.includes("moderate")}
							busy={busy === one.trip}
							onChange={(can) =>
								act(one.trip, () => api.changeAdmin(one.trip, { name: one.name, can }))
							}
							onDrop={() => act(one.trip, () => api.dropAdmin(one.trip))}
						/>
					))}
				</ul>
			</Card>

			<p className="px-1 text-fg-muted text-[11.5px] leading-relaxed">
				{t("A signature is what a passphrase produces, and it is public: it prints beside its owner's name in every room they join. Ask somebody for theirs rather than for their passphrase, which this server is never told and could not store.")}
			</p>
		</div>
	);
}

function Row({
	admin,
	canModerate,
	onlyModerator,
	busy,
	onChange,
	onDrop,
}: {
	admin: Administrator;
	canModerate: boolean;
	onlyModerator: boolean;
	busy: boolean;
	onChange: (can: string[]) => void;
	onDrop: () => void;
}) {
	const moderates = admin.can.includes("moderate");

	return (
		<li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-border border-b px-3 py-3 last:border-0 sm:px-4">
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="flex items-center gap-2">
					<span className="truncate text-fg text-sm">{admin.name || t("Unnamed")}</span>
					{admin.self && (
						<span className="rounded-full border border-border px-1.5 text-[10px] text-fg-muted">
							{t("you")}
						</span>
					)}
				</span>
				<span className="readout text-fg-muted text-[12px]">{admin.trip}</span>
			</div>

			<div className="ml-auto flex items-center gap-3">
				<label className="flex items-center gap-1.5 text-[12px] text-fg-muted">
					<input
						type="checkbox"
						checked={moderates}
						disabled={!canModerate || busy || onlyModerator}
						onChange={(event) =>
							onChange(event.target.checked ? ["moderate"] : [])
						}
						className="size-3.5 accent-tally disabled:opacity-40"
					/>
					{t("Can change things")}
				</label>

				{canModerate && (
					<button
						type="button"
						disabled={busy || onlyModerator}
						onClick={onDrop}
						title={onlyModerator ? t("The last administrator who can change things cannot be removed") : undefined}
						className={cn(
							"rounded-md border border-border p-1.5",
							onlyModerator ? "opacity-40" : "hover:bg-surface-2 hover:text-danger",
						)}
					>
						{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
					</button>
				)}
			</div>
		</li>
	);
}

function AddAdmin({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
	const [name, setName] = useState("");
	const [trip, setTrip] = useState("");
	const [moderates, setModerates] = useState(false);
	const [saving, setSaving] = useState(false);

	const submit = async () => {
		if (saving) return;

		setSaving(true);

		try {
			await api.addAdmin({ trip: trip.trim().toLowerCase(), name: name.trim(), can: moderates ? ["moderate"] : [] });
			onDone();
		} catch (err) {
			actionFailed(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<form
			className="flex flex-col gap-3 border-border border-b px-3 py-3 sm:px-4"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<div className="flex flex-wrap gap-2">
				<input
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder={t("Name")}
					aria-label={t("Name")}
					maxLength={64}
					className="min-w-32 flex-1 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
				/>

				<input
					value={trip}
					onChange={(event) => setTrip(event.target.value)}
					placeholder={t("Signature")}
					aria-label={t("Signature")}
					maxLength={10}
					required
					className="readout min-w-40 flex-1 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
				/>
			</div>

			<label className="flex items-center gap-1.5 text-[12px] text-fg-muted">
				<input
					type="checkbox"
					checked={moderates}
					onChange={(event) => setModerates(event.target.checked)}
					className="size-3.5 accent-tally"
				/>
				{t("Can change things")}
			</label>

			<div className="flex gap-2">
				<button
					type="submit"
					disabled={saving || trip.trim().length === 0}
					className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-2 disabled:opacity-40"
				>
					{saving ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
					{t("Add")}
				</button>

				<button
					type="button"
					onClick={onCancel}
					className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-2"
				>
					<X className="size-3.5" />
					{t("Cancel")}
				</button>
			</div>
		</form>
	);
}
