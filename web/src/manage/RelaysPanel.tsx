import { cn } from "@/lib/utils";
import { say, t } from "@/live/i18n";
import { actionFailed } from "@/live/notices";
import {
	Check,
	ChevronDown,
	ChevronUp,
	Copy,
	Loader2,
	Plus,
	RotateCw,
	Terminal,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useState } from "react";
import { type Relay, api } from "./api";
import { usePoll } from "./poll";
import { Card, Failed } from "./Shell";

/**
 * The media servers this deployment holds calls on.
 *
 * Adding one is a page rather than a line in a configuration file because of
 * when it happens: a relay is added the moment a machine is brought up, and
 * editing a file and restarting to record that would drop every call the
 * control node is holding — for an operation that changes nothing at all about
 * the calls already in progress somewhere else.
 *
 * Each row carries whether the relay answered, measured from the control node
 * when this page was drawn. That is deliberately not the same measurement a
 * client makes before joining: this says whether the machine is up, and the
 * client's says whether it is near them. A relay can be perfectly healthy here
 * and the wrong choice for somebody on another continent, and a row that
 * conflated the two would send an operator looking for a fault that is not one.
 */
export function RelaysPanel({
	canModerate,
	onSignedOut,
}: {
	canModerate: boolean;
	onSignedOut: () => void;
}) {
	// Often enough that a relay going down is noticed while somebody is
	// watching, rarely enough that the control node is not measuring every
	// relay continuously for a page nobody has open.
	const { value, error, refresh } = usePoll(api.relays, { every: 15_000, onSignedOut });

	const [adding, setAdding] = useState(false);
	const [script, setScript] = useState<string>();
	const [command, setCommand] = useState<string>();
	const [busy, setBusy] = useState<string>();

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

	const relays = value?.relays ?? [];

	return (
		<div className="flex flex-col gap-4">
			<Card
				title={t("Relays")}
				note={t("Where calls are held. This machine serves the page and carries no media.")}
				actions={
					canModerate &&
					!adding &&
					script === undefined && (
						<div className="flex items-center gap-2">
							{/* Two ways in, because they are different situations. A machine
							    somebody is holding gets the script; one that is already
							    running somewhere gets its address typed in. */}
							<button
								type="button"
								onClick={async () => {
									try {
										// Both, in one press. The command is what gets
										// used and the script is what makes it readable
										// before it is run as root.
										const [text, ready] = await Promise.all([
											api.relayScript(),
											api.relayCommand(),
										]);
										setCommand(ready.command);
										setScript(text);
									} catch {
										actionFailed(t("This deployment cannot bring up relays from a script."));
									}
								}}
								className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-2"
							>
								<Terminal className="size-3.5" />
								{t("Add a machine")}
							</button>

							<button
								type="button"
								onClick={() => setAdding(true)}
								className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-2"
							>
								<Plus className="size-3.5" />
								{t("Add by address")}
							</button>
						</div>
					)
				}
			>
				{script !== undefined ? (
					<AddByScript
						script={script}
						command={command}
						onDone={() => {
							setScript(undefined);
							setCommand(undefined);
						}}
					/>
				) : adding ? (
					<AddRelay
						onDone={async () => {
							setAdding(false);
							await refresh();
						}}
						onCancel={() => setAdding(false)}
					/>
				) : relays.length === 0 ? (
					<p className="px-4 py-6 text-center text-fg-muted text-xs">
						{t("No relays yet. Calls cannot be held until one is added.")}
					</p>
				) : null}
			</Card>

			{relays.map((relay, index) => (
				<RelayRow
					key={relay.name}
					// Which arrows to draw. The list is what the server sent, in
					// the order it sent it, so an end is an end.
					first={index === 0}
					last={index === relays.length - 1}
					onMove={(by) =>
						act(relay.name, () => {
							const order = relays.map((one) => one.name);
							const to = index + by;
							const moved = order[index];
							if (moved === undefined || to < 0 || to >= order.length) return Promise.resolve();

							order.splice(index, 1);
							order.splice(to, 0, moved);

							return api.reorderRelays(order);
						})
					}
					relay={relay}
					canModerate={canModerate}
					busy={busy === relay.name}
					onToggle={() =>
						act(relay.name, () => api.editRelay(relay.name, { enabled: !relay.enabled }))
					}
					onDrop={() => act(relay.name, () => api.dropRelay(relay.name))}
					onEdit={(change) => act(relay.name, () => api.editRelay(relay.name, change))}
					// The list is re-read, and reading it is what checks every
					// relay: the reachability on this page is measured when it is
					// drawn rather than remembered.
					onRecheck={() => act(relay.name, refresh)}
				/>
			))}
		</div>
	);
}

function RelayRow({
	relay,
	canModerate,
	busy,
	onToggle,
	onDrop,
	onEdit,
	onMove,
	onRecheck,
	first,
	last,
}: {
	relay: Relay;
	canModerate: boolean;
	busy: boolean;
	onMove: (by: number) => void;
	onRecheck: () => void;
	first: boolean;
	last: boolean;
	onToggle: () => void;
	onDrop: () => void;
	onEdit: (change: {
		name?: string;
		url?: string;
		region?: string;
		label?: string;
		fallback?: boolean;
	}) => void;
}) {
	const [confirming, setConfirming] = useState(false);

	// Shut by default. The settings are four fields and two switches and they
	// are read perhaps once in a machine's life, against a row that is looked at
	// whenever anybody wonders whether a relay is up — so leaving them open made
	// the page mostly forms and hid the one line anybody came for.
	const [showing, setShowing] = useState(false);

	return (
		<Card title={say(relay.label || relay.name)} note={relay.label ? relay.name : relay.region}>
			<div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className="truncate readout text-[12px]">{relay.url}</span>

						{relay.fallback && (
							<span className="shrink-0 rounded bg-fg/10 px-1.5 py-0.5 text-[10.5px] text-fg-muted">
								{t("Keep in reserve")}
							</span>
						)}

						{relay.adminOnly && (
							<span className="shrink-0 rounded bg-fg/10 px-1.5 py-0.5 text-[10.5px] text-fg-muted">
								{t("Administrators only")}
							</span>
						)}

						{!relay.enabled && (
							<span className="shrink-0 rounded bg-tally/15 px-1.5 py-0.5 text-[11px] text-tally">
								{t("Not taking new calls")}
							</span>
						)}
					</div>

					{/*
					  * A light before the sentence, on the same bands the client's
					  * own picker uses. The dot that used to be here was painted a
					  * colour this palette does not have, so on every reachable
					  * relay it was an eight-pixel hole beside the address — which
					  * is what anybody would read it as.
					  */}
					<p className="mt-1 flex items-center gap-2 text-fg-muted text-xs">
						<span
							className={cn(
								"size-2 shrink-0 rounded-full",
								!relay.reachable
									? "bg-danger"
									: (relay.latencyMs ?? 0) <= 150
										? "bg-good"
										: (relay.latencyMs ?? 0) <= 400
											? "bg-tally"
											: "bg-danger",
							)}
							aria-hidden
						/>

						{relay.reachable
							? t("Answered in {ms} ms", { ms: relay.latencyMs ?? 0 })
							: relay.detail
								? t("Did not answer: {reason}", { reason: relay.detail })
								: t("Did not answer")}
					</p>
				</div>

				<div className="flex shrink-0 items-center gap-2">
					{busy && <Loader2 className="size-4 animate-spin text-fg-muted" />}

					{/* No cooldown on this one. It is one connection from one
					    machine that already checks every relay on a timer; what
					    the client's own button is rate limited against is every
					    browser doing it at once. */}
					<button
						type="button"
						onClick={onRecheck}
						disabled={busy}
						aria-label={t("Measure again")}
						title={t("Measure again")}
						className="rounded-md border border-border p-1.5 text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40"
					>
						<RotateCw className={cn("size-3.5", busy && "animate-spin")} />
					</button>

					{canModerate && (
						<button
							type="button"
							onClick={() => setShowing(!showing)}
							aria-expanded={showing}
							aria-label={t("Settings")}
							title={t("Settings")}
							className={cn(
								"rounded-md border border-border p-1.5 text-fg-muted transition-colors",
								"hover:bg-surface-2 hover:text-fg",
								showing && "bg-surface-2 text-fg",
							)}
						>
							<ChevronDown
								className={cn("size-3.5 transition-transform duration-200", showing && "rotate-180")}
							/>
						</button>
					)}
				</div>

				{canModerate && (
					<div className="flex shrink-0 items-center gap-2">

						{/* Order is not something this server can work out. Alphabetical
						    puts a reserve above the relay holding every call, and by-date
						    puts whichever machine was rebuilt last at the bottom. */}
						<div className="flex items-center">
							<button
								type="button"
								disabled={busy || first}
								onClick={() => onMove(-1)}
								aria-label={t("Move up")}
								className="rounded-l-md border border-border p-1.5 hover:bg-surface-2 disabled:opacity-30"
							>
								<ChevronUp className="size-3.5" />
							</button>
							<button
								type="button"
								disabled={busy || last}
								onClick={() => onMove(1)}
								aria-label={t("Move down")}
								className="-ml-px rounded-r-md border border-border p-1.5 hover:bg-surface-2 disabled:opacity-30"
							>
								<ChevronDown className="size-3.5" />
							</button>
						</div>

						<button
							type="button"
							onClick={onToggle}
							disabled={busy}
							className="rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-2 disabled:opacity-50"
						>
							{relay.enabled ? t("Stop sending here") : t("Send calls here")}
						</button>

						{confirming ? (
							<div className="flex items-center gap-1">
								{/* Named rather than a bare tick, because removing a relay and
								    disabling one are a keystroke apart and only one of them is
								    reversible by somebody who did not write the address down. */}
								<button
									type="button"
									onClick={() => {
										setConfirming(false);
										onDrop();
									}}
									disabled={busy}
									className="flex items-center gap-1 rounded-md bg-danger px-2.5 py-1 text-[12px] text-white hover:opacity-90 disabled:opacity-50"
								>
									<Check className="size-4" />
									{t("Remove")}
								</button>
								<button
									type="button"
									onClick={() => setConfirming(false)}
									className="rounded-md border border-border p-1.5 hover:bg-surface-2"
									aria-label={t("Cancel")}
								>
									<X className="size-4" />
								</button>
							</div>
						) : (
							<button
								type="button"
								onClick={() => setConfirming(true)}
								disabled={busy}
								className="rounded-md border border-border p-1.5 text-fg-muted hover:bg-surface-2 hover:text-danger disabled:opacity-50"
								aria-label={t("Remove relay")}
							>
								<Trash2 className="size-4" />
							</button>
						)}
					</div>
				)}
			</div>

			{canModerate && showing && (
				<Settings relay={relay} busy={busy} onSave={(change) => onEdit(change)} />
			)}

			{confirming && (
				<p className="px-4 pb-3 text-fg-muted text-xs">
					{t(
						"Calls already on this relay keep running; this only stops new ones being sent there.",
					)}
				</p>
			)}
		</Card>
	);
}

/**
 * Everything about this relay that can be changed.
 *
 * All of it, including the name and the address. Neither used to be editable and
 * both needed to be: an address changes when a machine moves or its port does,
 * and a name is whatever somebody typed at a prompt on the night the machine was
 * built — usually before anybody knew what it would end up being for.
 *
 * The name is still the key, and changing it still costs something: a client
 * that measured the old one sends it at the next join and is quietly ignored,
 * falling back to wherever the room already is. That is one join with a wasted
 * measurement, which is a great deal cheaper than a deployment stuck with the
 * word "sh" forever.
 *
 * Saved together rather than field by field, because they are usually changed
 * together — a machine that moved has a new address and often a new name — and
 * because a form that saves on every keystroke is one that saves halfway
 * through a word.
 */
function Settings({
	relay,
	busy,
	onSave,
}: {
	relay: Relay;
	busy: boolean;
	onSave: (change: {
		name?: string;
		url?: string;
		region?: string;
		label?: string;
		fallback?: boolean;
		adminOnly?: boolean;
	}) => void;
}) {
	const [name, setName] = useState(relay.name);
	const [url, setUrl] = useState(relay.url);
	const [region, setRegion] = useState(relay.region ?? "");
	const [label, setLabel] = useState(relay.label ?? "");

	const dirty =
		name !== relay.name ||
		url !== relay.url ||
		region !== (relay.region ?? "") ||
		label !== (relay.label ?? "");

	return (
		<div className="flex flex-col gap-3 border-border border-t px-4 py-3">
			<div className="flex flex-wrap gap-3">
				<Field label={t("Name")} hint={t("How this deployment refers to it")}>
					<input
						value={name}
						onChange={(event) => setName(event.target.value)}
						maxLength={64}
						className="readout w-full rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
					/>
				</Field>

				<Field label={t("Shown to people as")} hint={t("Left empty, the name is used")}>
					<input
						value={label}
						onChange={(event) => setLabel(event.target.value)}
						placeholder={relay.name}
						maxLength={64}
						className="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
					/>
				</Field>
			</div>

			<div className="flex flex-wrap gap-3">
				<Field label={t("Address")} hint={t("What a browser dials")} wide>
					<input
						value={url}
						onChange={(event) => setUrl(event.target.value)}
						placeholder="wss://host:port"
						className="readout w-full rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
					/>
				</Field>

				<Field label={t("Region")} hint={t("Groups the picker. A slash nests: Oversea/Asia")}>
					<input
						value={region}
						onChange={(event) => setRegion(event.target.value)}
						maxLength={64}
						className="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-fg/40"
					/>
				</Field>
			</div>

			<div className="flex flex-wrap items-center gap-4">
				<label className="flex items-center gap-1.5 text-[12px] text-fg-muted">
					<input
						type="checkbox"
						checked={relay.fallback ?? false}
						disabled={busy}
						onChange={(event) => onSave({ fallback: event.target.checked })}
						className="size-3.5 accent-tally"
					/>
					{t("Keep in reserve")}
				</label>

				{/* Distinct from taking it out of service, and from keeping it in
				    reserve: those are about when to use it, this is about who may.
				    Refused at the join as well as hidden from the list, or somebody
				    who read the name off a colleague's screen could ask for it. */}
				<label className="flex items-center gap-1.5 text-[12px] text-fg-muted">
					<input
						type="checkbox"
						checked={relay.adminOnly ?? false}
						disabled={busy}
						onChange={(event) => onSave({ adminOnly: event.target.checked })}
						className="size-3.5 accent-tally"
					/>
					{t("Administrators only")}
				</label>

				<button
					type="button"
					disabled={busy || !dirty}
					onClick={() => onSave({ name, url, region, label })}
					className="ml-auto rounded-md border border-border px-2.5 py-1.5 text-[12px] hover:bg-surface-2 disabled:opacity-40"
				>
					{t("Save")}
				</button>
			</div>
		</div>
	);
}

function Field({
	label,
	hint,
	wide,
	children,
}: {
	label: string;
	hint: string;
	wide?: boolean;
	children: React.ReactNode;
}) {
	return (
		<label className={cn("flex flex-col gap-1", wide ? "min-w-64 flex-[2]" : "min-w-40 flex-1")}>
			<span className="text-fg-muted text-[11px]">{label}</span>
			{children}
			<span className="text-fg-muted/70 text-[10.5px]">{hint}</span>
		</label>
	);
}

function AddRelay({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [region, setRegion] = useState("");
	const [saving, setSaving] = useState(false);

	const submit = useCallback(async () => {
		if (saving) return;

		setSaving(true);

		try {
			await api.addRelay({
				name: name.trim(),
				url: url.trim(),
				region: region.trim() || undefined,
			});
			onDone();
		} catch (err) {
			actionFailed(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [name, url, region, saving, onDone]);

	return (
		<form
			className="flex flex-col gap-3 px-4 py-3"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<div className="grid gap-3 sm:grid-cols-3">
				<label className="flex flex-col gap-1">
					<span className="text-fg-muted text-xs">{t("Name")}</span>
					<input
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder="tokyo"
						required
						className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm"
					/>
				</label>

				<label className="flex flex-col gap-1 sm:col-span-2">
					<span className="text-fg-muted text-xs">{t("Address")}</span>
					<input
						value={url}
						onChange={(event) => setUrl(event.target.value)}
						placeholder="wss://tokyo.example.com"
						required
						className="rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-sm"
					/>
				</label>
			</div>

			<label className="flex flex-col gap-1">
				<span className="text-fg-muted text-xs">{t("Region (optional)")}</span>
				<input
					value={region}
					onChange={(event) => setRegion(event.target.value)}
					placeholder="jp"
					className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm sm:max-w-48"
				/>
			</label>

			<p className="text-fg-muted text-xs">
				{t("The address a browser dials. It must begin ws:// or wss://, and the relay must be running with role: relay.")}
			</p>

			<div className="flex gap-2">
				<button
					type="submit"
					disabled={saving || !name.trim() || !url.trim()}
					className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-2 disabled:opacity-50"
				>
					{saving && <Loader2 className="size-4 animate-spin" />}
					{t("Add relay")}
				</button>

				<button
					type="button"
					onClick={onCancel}
					className="rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-2"
				>
					{t("Cancel")}
				</button>
			</div>
		</form>
	);
}

/**
 * The one line, laid out to be copied rather than read.
 *
 * Wrapped rather than scrolled sideways: a command that runs off the edge gets
 * copied in half by anybody selecting it by hand, and the half that goes missing
 * is the end, which is where the secret is.
 */
function Command({ command }: { command: string }) {
	const [copied, setCopied] = useState(false);

	return (
		<div className="relative">
			<pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-surface-2 p-3 pr-20 text-[11.5px] leading-relaxed">
				<code>{command}</code>
			</pre>

			<button
				type="button"
				onClick={async () => {
					try {
						await navigator.clipboard.writeText(command);
						setCopied(true);
						setTimeout(() => setCopied(false), 2000);
					} catch {
						actionFailed(t("Could not copy. Select the text and copy it."));
					}
				}}
				className="absolute top-2 right-2 flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] hover:bg-surface-2"
			>
				{copied ? <Check className="size-3" /> : <Copy className="size-3" />}
				{copied ? t("Copied") : t("Copy")}
			</button>
		</div>
	);
}

/**
 * The script that brings a machine up as a relay.
 *
 * Shown rather than run: this is somebody else's machine, and the only thing
 * this server can do about it is hand over the instructions. What comes back
 * afterwards is the relay appearing in the list above, which is how anybody
 * knows it worked.
 *
 * The warning is not decoration. The script carries the enrolment secret, and
 * that secret buys the credential every relay in this deployment signs with.
 */
function AddByScript({
	script,
	command,
	onDone,
}: { script: string; command?: string; onDone: () => void }) {
	const [copied, setCopied] = useState(false);

	return (
		<div className="flex flex-col gap-3 px-4 py-3">
			<p className="text-fg-muted text-xs">
				{t("Run this on the new machine as root. Replace <prefix> with the name it should answer to. It does the rest: fetches the binary, takes this deployment's certificate and credentials, points a name at the machine, and starts the relay.")}
			</p>

			{command && <Command command={command} />}

			<p className="text-fg-muted text-xs">
				{t("What that runs, in full. Worth reading before running anything as root.")}
			</p>

			<div className="relative">
				<pre className="max-h-64 overflow-auto rounded-md border border-border bg-surface-2 p-3 text-[11px] leading-relaxed">
					<code>{script}</code>
				</pre>

				<button
					type="button"
					onClick={async () => {
						try {
							await navigator.clipboard.writeText(script);
							setCopied(true);
							setTimeout(() => setCopied(false), 2000);
						} catch {
							actionFailed(t("Could not copy. Select the text and copy it."));
						}
					}}
					className="absolute top-2 right-2 flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] hover:bg-surface-2"
				>
					{copied ? <Check className="size-3" /> : <Copy className="size-3" />}
					{copied ? t("Copied") : t("Copy")}
				</button>
			</div>

			<p className="rounded-md border border-tally/40 bg-tally/10 px-3 py-2 text-[11px] text-tally">
				{t("This script carries the key to this deployment. Anybody who has it can add a relay, so do not put it anywhere it will be kept.")}
			</p>

			<div>
				<button
					type="button"
					onClick={onDone}
					className="rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-2"
				>
					{t("Done")}
				</button>
			</div>
		</div>
	);
}
