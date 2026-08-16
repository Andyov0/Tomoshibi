import { cn } from "@/lib/utils";
import { t } from "@/live/i18n";
import { actionFailed } from "@/live/notices";
import { Ban, KeyRound, Loader2, Plus, Trash2, Undo2, X } from "lucide-react";
import { useCallback, useState } from "react";
import { api } from "./api";
import { usePoll } from "./poll";
import { Card, Failed } from "./Shell";
import { since } from "./units";

/**
 * The accounts an administrator hands out.
 *
 * Until this existed there were two kinds of person here: administrators, and
 * whoever anybody said they were. That is the right model for an anonymous
 * meeting link and the wrong one for a group who all come back — there was no
 * way to give somebody a name that was theirs without making them an
 * administrator of the whole deployment.
 *
 * An account is a name and a first passphrase. The passphrase becomes a
 * signature the moment it is typed and is not stored, which has one consequence
 * worth saying on the page rather than only in a comment: nobody can be shown
 * somebody's passphrase later, because there is none to show. What an
 * administrator can do is set a new one, which is the useful half of that
 * request and the only half that was ever safe.
 */
export function AccountsPanel({
	canModerate,
	onSignedOut,
}: {
	canModerate: boolean;
	onSignedOut: () => void;
}) {
	const { value, error, refresh } = usePoll(api.accounts, { every: 30_000, onSignedOut });

	const [adding, setAdding] = useState(false);
	const [busy, setBusy] = useState<string>();
	const [resetting, setResetting] = useState<string>();
	const [made, setMade] = useState<{ name: string; passphrase: string }>();

	const act = useCallback(
		async (name: string, run: () => Promise<unknown>) => {
			if (busy) return;

			setBusy(name);

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

	const accounts = value ?? [];

	return (
		<div className="mx-auto flex max-w-4xl flex-col gap-3 sm:gap-4">
			<Card
				title="Accounts"
				note={`${accounts.length}`}
				actions={
					canModerate &&
					!adding && (
						<button
							type="button"
							onClick={() => setAdding(true)}
							className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-2"
						>
							<Plus className="size-3.5" />
							{t("New account")}
						</button>
					)
				}
			>
				{adding && (
					<NewAccount
						onDone={async (name, passphrase) => {
							setAdding(false);
							setMade({ name, passphrase });
							await refresh();
						}}
						onCancel={() => setAdding(false)}
					/>
				)}

				{/*
				  * Shown once, here, and never again — because it is never stored.
				  * Whoever made the account is the only person who can pass it on,
				  * and they have to do it now.
				  */}
				{made && (
					<div className="flex flex-wrap items-center gap-2 border-border border-b bg-tally/10 px-3 py-3 sm:px-4">
						<span className="text-[12px] text-fg">
							{t("Give this to {name} now. It is not stored and cannot be shown again.", {
								name: made.name,
							})}
						</span>
						<code className="readout rounded bg-surface-2 px-2 py-1 text-[12.5px] text-fg">
							{made.passphrase}
						</code>
						<button
							type="button"
							onClick={() => setMade(undefined)}
							className="ml-auto rounded-md border border-border p-1 hover:bg-surface-2"
							aria-label={t("Dismiss")}
						>
							<X className="size-3.5" />
						</button>
					</div>
				)}

				{accounts.length === 0 && !adding && (
					<p className="px-3 py-4 text-fg-muted text-sm sm:px-4">
						{t("No accounts yet. Somebody without one can still join a room, under whatever name they choose.")}
					</p>
				)}

				<ul>
					{accounts.map((account) => (
						<li
							key={account.name}
							className={cn(
								"flex flex-wrap items-center gap-x-4 gap-y-2 border-border border-b px-3 py-3 last:border-0 sm:px-4",
								account.blocked && "bg-danger/5",
							)}
						>
							<Face account={account} />

							<div className="flex min-w-0 flex-col gap-0.5">
								<span className="flex items-center gap-2">
									<span className="truncate text-fg text-sm">{account.name}</span>

									{account.blocked && (
										<span className="rounded bg-danger/15 px-1.5 py-0.5 text-[10.5px] text-danger">
											{t("blocked")}
										</span>
									)}
								</span>

								<span className="readout text-fg-muted text-[12px]">{account.trip}</span>
							</div>

							<div className="ml-auto flex items-center gap-3">
								<span className="text-fg-muted text-xs tabular-nums">
									{account.lastSeen ? since(account.lastSeen) : t("never here")}
								</span>

								{canModerate && (
									<div className="flex items-center gap-1.5">
										{busy === account.name && (
											<Loader2 className="size-3.5 animate-spin text-fg-muted" />
										)}

										<button
											type="button"
											onClick={() => setResetting(account.name)}
											aria-label={t("Set a new passphrase")}
											title={t("Set a new passphrase")}
											className="rounded-md border border-border p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg"
										>
											<KeyRound className="size-3.5" />
										</button>

										<button
											type="button"
											disabled={busy === account.name}
											onClick={() =>
												act(account.name, () =>
													api.changeAccount(account.name, { blocked: !account.blocked }),
												)
											}
											aria-label={account.blocked ? t("Let back in") : t("Block")}
											title={account.blocked ? t("Let back in") : t("Block")}
											className="rounded-md border border-border p-1.5 text-fg-muted hover:bg-surface-2 hover:text-danger disabled:opacity-40"
										>
											{account.blocked ? (
												<Undo2 className="size-3.5" />
											) : (
												<Ban className="size-3.5" />
											)}
										</button>

										<button
											type="button"
											disabled={busy === account.name}
											onClick={() => act(account.name, () => api.dropAccount(account.name))}
											aria-label={t("Remove")}
											title={t("Remove")}
											className="rounded-md border border-border p-1.5 text-fg-muted hover:bg-surface-2 hover:text-danger disabled:opacity-40"
										>
											<Trash2 className="size-3.5" />
										</button>
									</div>
								)}
							</div>

							{resetting === account.name && (
								<NewPassphrase
									onDone={async (passphrase) => {
										setResetting(undefined);
										await act(account.name, () =>
											api.changeAccount(account.name, { passphrase }),
										);
										setMade({ name: account.name, passphrase });
									}}
									onCancel={() => setResetting(undefined)}
								/>
							)}
						</li>
					))}
				</ul>
			</Card>

			<p className="px-1 text-fg-muted text-[11.5px] leading-relaxed">
				{t("A passphrase is never stored, so nobody can be shown one later — not even you. What you can do is set a new one and pass it on. People sign in at /account to change it themselves and to choose a picture.")}
			</p>
		</div>
	);
}

/** Somebody's picture, or their initial where they have not chosen one. */
function Face({ account }: { account: { name: string; trip: string; avatar?: boolean } }) {
	if (account.avatar) {
		return (
			<img
				src={`/api/avatar/${encodeURIComponent(account.trip)}`}
				alt=""
				className="size-8 shrink-0 rounded-full object-cover"
			/>
		);
	}

	return (
		<span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-fg-muted text-sm">
			{account.name.slice(0, 1).toUpperCase()}
		</span>
	);
}

function NewAccount({
	onDone,
	onCancel,
}: {
	onDone: (name: string, passphrase: string) => void;
	onCancel: () => void;
}) {
	const [name, setName] = useState("");
	const [passphrase, setPassphrase] = useState(() => suggest());
	const [saving, setSaving] = useState(false);

	const submit = async () => {
		if (saving) return;

		setSaving(true);

		try {
			await api.addAccount(name.trim(), passphrase);
			onDone(name.trim(), passphrase);
		} catch (err) {
			actionFailed(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<form
			className="flex flex-wrap items-end gap-2 border-border border-b px-3 py-3 sm:px-4"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<label className="flex min-w-32 flex-1 flex-col gap-1">
				<span className="text-fg-muted text-[11px]">{t("Name")}</span>
				<input
					value={name}
					onChange={(event) => setName(event.target.value)}
					maxLength={32}
					required
					// biome-ignore lint/a11y/noAutofocus: the form opened because it was asked for
					autoFocus
					className="rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
				/>
			</label>

			<label className="flex min-w-48 flex-[2] flex-col gap-1">
				{/* Generated rather than typed, and shown rather than hidden. It is
				    about to be read out or pasted into a message, and whoever is
				    doing that has to see it. */}
				<span className="text-fg-muted text-[11px]">{t("First passphrase")}</span>
				<input
					value={passphrase}
					onChange={(event) => setPassphrase(event.target.value)}
					minLength={8}
					required
					className="readout rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
				/>
			</label>

			<button
				type="submit"
				disabled={saving || !name.trim() || passphrase.length < 8}
				className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] hover:bg-surface-2 disabled:opacity-40"
			>
				{saving ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
				{t("Create")}
			</button>

			<button
				type="button"
				onClick={onCancel}
				className="rounded-md border border-border px-2.5 py-1.5 text-[12px] hover:bg-surface-2"
			>
				{t("Cancel")}
			</button>
		</form>
	);
}

function NewPassphrase({
	onDone,
	onCancel,
}: {
	onDone: (passphrase: string) => void;
	onCancel: () => void;
}) {
	const [passphrase, setPassphrase] = useState(() => suggest());

	return (
		<form
			className="flex w-full flex-wrap items-center gap-2 pt-1"
			onSubmit={(event) => {
				event.preventDefault();
				onDone(passphrase);
			}}
		>
			<input
				value={passphrase}
				onChange={(event) => setPassphrase(event.target.value)}
				minLength={8}
				// biome-ignore lint/a11y/noAutofocus: the field appeared because it was asked for
				autoFocus
				className="readout min-w-48 flex-1 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
			/>

			<button
				type="submit"
				disabled={passphrase.length < 8}
				className="rounded-md border border-border px-2.5 py-1.5 text-[12px] hover:bg-surface-2 disabled:opacity-40"
			>
				{t("Set it")}
			</button>

			<button
				type="button"
				onClick={onCancel}
				className="rounded-md border border-border px-2.5 py-1.5 text-[12px] hover:bg-surface-2"
			>
				{t("Cancel")}
			</button>
		</form>
	);
}

/**
 * A passphrase nobody has to invent.
 *
 * Offered filled in because the alternative is somebody typing the name of the
 * deployment twice, and because this one is going to be sent in a message and
 * then changed — it needs to be unguessable and readable aloud, not memorable.
 */
function suggest(): string {
	const alphabet = "abcdefghijkmnopqrstuvwxyz23456789";
	const raw = crypto.getRandomValues(new Uint8Array(16));

	return Array.from(raw, (byte) => alphabet[byte % alphabet.length]).join("");
}
