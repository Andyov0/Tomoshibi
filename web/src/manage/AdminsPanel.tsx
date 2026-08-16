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

	// Anybody who may change things may change who else can, because there is
	// one kind of administrator here and it was not worth inventing a second.
	const canAppoint = canModerate;

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
					canAppoint &&
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
							canAppoint={canAppoint}
							// The last person who can appoint anybody cannot be
							// removed or demoted, and the server refuses it either
							// way. Said here too, so the control is not offered and
							// then refused.
							onlyOwner={moderators === 1 && one.can.includes("moderate")}
							busy={busy === one.trip}
							onChange={(can) =>
								act(one.trip, () => api.changeAdmin(one.trip, { name: one.name, can }))
							}
							onDrop={() => act(one.trip, () => api.dropAdmin(one.trip))}
							onRename={(name) =>
								act(one.trip, () => api.changeAdmin(one.trip, { name, can: one.can }))
							}
						/>
					))}
				</ul>
			</Card>

			<OwnPassphrase />

			<p className="px-1 text-fg-muted text-[11.5px] leading-relaxed">
				{t("A signature is what a passphrase produces, and it is public: it prints beside its owner's name in every room they join. Ask somebody for theirs rather than for their passphrase, which this server is never told and could not store.")}
			</p>
		</div>
	);
}

function Row({
	admin,
	canAppoint,
	onlyOwner,
	busy,
	onChange,
	onDrop,
	onRename,
}: {
	admin: Administrator;
	canAppoint: boolean;
	onlyOwner: boolean;
	busy: boolean;
	onChange: (can: string[]) => void;
	onDrop: () => void;
	onRename: (name: string) => void;
}) {
	const [name, setName] = useState(admin.name);
	const role = admin.can.includes("moderate") ? "moderate" : "observe";

	return (
		<li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-border border-b px-3 py-3 last:border-0 sm:px-4">
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="flex items-center gap-2">
					{canAppoint ? (
						<input
							value={name}
							onChange={(event) => setName(event.target.value)}
							onBlur={() => {
								// Saved on leaving the field rather than on every
								// keystroke, which would save halfway through a word.
								if (name.trim() !== admin.name) onRename(name.trim());
							}}
							placeholder={t("Unnamed")}
							maxLength={64}
							className="w-32 min-w-0 rounded border border-transparent bg-transparent px-1 py-0.5 text-fg text-sm outline-none hover:border-border focus:border-border focus:bg-surface-2"
						/>
					) : (
						<span className="truncate text-fg text-sm">{admin.name || t("Unnamed")}</span>
					)}
					{admin.self && (
						<span className="rounded-full border border-border px-1.5 text-[10px] text-fg-muted">
							{t("you")}
						</span>
					)}
				</span>
				<span className="readout text-fg-muted text-[12px]">{admin.trip}</span>
			</div>

			<div className="ml-auto flex items-center gap-3">
				{/*
				  * Three levels, as one control rather than two checkboxes. They
				  * are ordered — an owner may moderate, a moderator may watch —
				  * so a pair of boxes would admit combinations that mean nothing
				  * and invite somebody to tick the wrong one of them.
				  */}
				<select
					value={role}
					disabled={!canAppoint || busy || onlyOwner}
					onChange={(event) => onChange(roleTo(event.target.value))}
					className={cn(
						"rounded-md border border-border bg-surface-2 px-2 py-1 text-[12px] text-fg",
						"outline-none transition-colors hover:border-fg/20",
						"focus-visible:ring-2 focus-visible:ring-fg/40 disabled:opacity-40",
					)}
					title={onlyOwner ? t("The last administrator who can change things cannot be removed") : undefined}
				>
					<option value="observe">{t("Can watch")}</option>
					<option value="moderate">{t("Can change things")}</option>
				</select>

				{canAppoint && (
					<button
						type="button"
						disabled={busy || onlyOwner}
						onClick={onDrop}
						title={onlyOwner ? t("The last administrator who can change things cannot be removed") : undefined}
						className={cn(
							"rounded-md border border-border p-1.5",
							onlyOwner ? "opacity-40" : "hover:bg-surface-2 hover:text-danger",
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
	const [role, setRole] = useState("observe");
	const [saving, setSaving] = useState(false);

	const submit = async () => {
		if (saving) return;

		setSaving(true);

		try {
			await api.addAdmin({
				trip: trip.trim().toLowerCase(),
				name: name.trim(),
				can: roleTo(role),
			});
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

			<label className="flex items-center gap-2 text-[12px] text-fg-muted">
				{t("May")}
				<select
					value={role}
					onChange={(event) => setRole(event.target.value)}
					className="rounded-md border border-border bg-surface-2 px-2 py-1 text-[12px] text-fg outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
				>
					<option value="observe">{t("Can watch")}</option>
					<option value="moderate">{t("Can change things")}</option>
				</select>
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

/**
 * Changing your own passphrase.
 *
 * There is no password on this server to change. The passphrase is never sent
 * here in any form that is kept and never written down — what is stored is the
 * signature it produces — so rotating one means being recognised by a new
 * signature from now on. Which is why the new signature is shown afterwards: it
 * is what prints beside this person's name in every room from then on, and they
 * are the one person who has to know it moved.
 *
 * The current one is asked for even though the session already says who this is.
 * A session proves somebody signed in; this asks whether the person at the
 * keyboard now is that person, and an unattended laptop is exactly where those
 * two differ.
 */
function OwnPassphrase() {
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [saving, setSaving] = useState(false);
	const [changed, setChanged] = useState<string>();

	const submit = async () => {
		if (saving) return;

		setSaving(true);

		try {
			const result = await api.changePassphrase(current, next);
			setCurrent("");
			setNext("");
			setChanged(result.trip);
		} catch (err) {
			actionFailed(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Card title="Your passphrase">
			<form
				className="flex flex-col gap-3 px-3 py-3 sm:px-4"
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<div className="flex flex-wrap gap-2">
					<input
						type="password"
						value={current}
						onChange={(event) => setCurrent(event.target.value)}
						placeholder={t("Current passphrase")}
						aria-label={t("Current passphrase")}
						autoComplete="current-password"
						className="min-w-40 flex-1 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
					/>

					<input
						type="password"
						value={next}
						onChange={(event) => setNext(event.target.value)}
						placeholder={t("New passphrase")}
						aria-label={t("New passphrase")}
						autoComplete="new-password"
						className="min-w-40 flex-1 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
					/>
				</div>

				<div className="flex items-center gap-3">
					<button
						type="submit"
						disabled={saving || !current || next.length < 8}
						className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-2 disabled:opacity-40"
					>
						{saving && <Loader2 className="size-3.5 animate-spin" />}
						{t("Change it")}
					</button>

					{changed ? (
						<span className="text-[11.5px] text-fg-muted">
							{t("Done. Your signature is now")} <span className="readout text-fg">{changed}</span>
						</span>
					) : (
						<span className="text-[11.5px] text-fg-muted">{t("At least eight characters.")}</span>
					)}
				</div>
			</form>
		</Card>
	);
}

/** What a chosen level means to the server. Observe is held by everybody. */
function roleTo(role: string): string[] {
	return role === "moderate" ? ["moderate"] : [];
}
