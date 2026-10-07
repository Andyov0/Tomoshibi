import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { t } from "@/live/i18n";
import { whenSaid } from "@/live/meeting";
import { MAX_SCOPE, normaliseRoomName, validRoomName, validScope } from "@/live/names";
import { actionDone, actionFailed } from "@/live/notices";
import { ArrowLeft, Camera, Check, Copy, Link2, Link2Off, Loader2, LogOut, Shield, Trash2, UserRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Somebody's own account: their passphrase, their picture, and the links they
 * may make into their scopes' rooms.
 *
 * Nothing else, and that is the design rather than the current state of it.
 * Everything else on this deployment — the relays, the rooms, who else may be
 * here — belongs to whoever runs it, and a page that grew a second column for
 * some people and not others would be one mistake away from showing the wrong
 * person the wrong thing.
 *
 * The links are the one thing here that reaches past the account, and they are
 * here because they are the account's: being in a scope is what lets somebody
 * let a guest into its rooms, and the person doing it is usually not in a call
 * at the time — they are sending next Tuesday's client a link today.
 *
 * The passphrase is not stored anywhere and cannot be recovered. That is worth
 * saying on the page, because the first thing anybody does when they forget one
 * is look for the button that sends it to them, and there is none to find: an
 * administrator sets a new one instead.
 */
interface Me {
	name: string;
	trip: string;
	avatar?: string;
	created?: string;
	/** Whether they also run the deployment, so the way there can be offered. */
	admin?: boolean;
	/** The groups they belong to, whose rooms they may send links into. */
	scopes?: string[];
}

export function Account() {
	const [me, setMe] = useState<Me>();
	const [asking, setAsking] = useState(true);

	const identify = useCallback(async () => {
		try {
			const response = await fetch("/api/account/me", { credentials: "same-origin" });
			setMe(response.ok ? ((await response.json()) as Me) : undefined);
		} catch {
			setMe(undefined);
		} finally {
			setAsking(false);
		}
	}, []);

	useEffect(() => {
		void identify();
	}, [identify]);

	if (asking) return <div className="min-h-full bg-bg" />;
	if (!me) return <SignIn onIn={identify} />;

	return (
		<main className="mx-auto flex min-h-full max-w-lg flex-col gap-4 bg-bg p-5 text-fg sm:p-6">
			{/*
			 * The way back, first and above everything.
			 *
			 * This is a page somebody arrives at from the front of the site, does
			 * one thing on, and leaves — and until this existed the only way out
			 * was the browser's own back button, which is not where anybody looks
			 * on a page that has its own address. A page with no exit reads as a
			 * place you have been sent rather than one you visited.
			 */}
			<nav className="animate-rise flex items-center gap-2">
				<a
					href="/"
					className={cn(
						"flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5",
						"text-[12px] text-fg-muted transition-colors hover:bg-surface-hi hover:text-fg",
					)}
				>
					<ArrowLeft className="size-3.5" />
					{t("Back to meetings")}
				</a>

				{me.admin && (
					<a
						href="/admin"
						className={cn(
							"ml-auto flex items-center gap-1.5 rounded-md border border-tally/30 bg-tally/10 px-2.5 py-1.5",
							"text-[12px] text-fg transition-colors hover:bg-tally/20",
						)}
					>
						<Shield className="size-3.5 text-tally" />
						{t("Admin console")}
					</a>
				)}
			</nav>

			<div className="animate-rise [animation-delay:60ms]">
				<Header me={me} onChanged={setMe} />
			</div>

			<div className="animate-rise [animation-delay:120ms]">
				<Picture me={me} onChanged={setMe} />
			</div>

			{/* Only for somebody who can use it. An administrator belongs to
			    every scope and may type any; anybody else is offered the ones on
			    their account, and an account with none has no rooms to send
			    anybody into. */}
			{(me.admin || (me.scopes?.length ?? 0) > 0) && (
				<div className="animate-rise [animation-delay:180ms]">
					<GuestLinks me={me} />
				</div>
			)}

			<div className="animate-rise [animation-delay:240ms]">
				<Passphrase />
			</div>

			<p className="animate-rise [animation-delay:300ms] px-1 text-fg-muted text-[11.5px] leading-relaxed">
				{t("Your passphrase is not stored here and cannot be sent to you. If you lose it, an administrator sets a new one.")}
			</p>
		</main>
	);
}

function SignIn({ onIn }: { onIn: () => void }) {
	const [name, setName] = useState("");
	const [passphrase, setPassphrase] = useState("");
	const [busy, setBusy] = useState(false);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();

		if (busy) return;

		setBusy(true);

		try {
			const response = await fetch("/api/account/session", {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify({ name, passphrase }),
			});

			if (!response.ok) throw new Error(t("That name and passphrase do not go together."));

			onIn();
		} catch (err) {
			// The field is cleared for the next attempt, and the notice fades:
			// a refused attempt is something that happened, not something still
			// true.
			actionFailed(err instanceof Error ? err.message : String(err));
			setPassphrase("");
		} finally {
			setBusy(false);
		}
	};

	return (
		<main className="grid min-h-full place-items-center bg-bg p-6 text-fg">
			<form onSubmit={submit} className="animate-rise flex w-full max-w-sm flex-col gap-4">
				<header className="flex flex-col items-center gap-2 text-center">
					<UserRound className="size-8 text-fg-muted" />
					<h1 className="font-semibold text-xl tracking-tight">{t("Your account")}</h1>
					<p className="text-fg-muted text-sm">{t("Sign in to change your passphrase or picture.")}</p>
				</header>

				<Input
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder={t("Name")}
					aria-label={t("Name")}
					autoComplete="username"
					// biome-ignore lint/a11y/noAutofocus: the page exists to be typed into
					autoFocus
					maxLength={32}
				/>

				<Input
					type="password"
					value={passphrase}
					onChange={(event) => setPassphrase(event.target.value)}
					placeholder={t("Passphrase")}
					aria-label={t("Passphrase")}
					autoComplete="current-password"
					maxLength={200}
				/>

				<Button type="submit" variant="primary" size="lg" disabled={busy || !name || !passphrase}>
					{busy ? <Loader2 className="size-4 animate-spin" /> : t("Sign in")}
				</Button>
			</form>
		</main>
	);
}

function Header({ me, onChanged }: { me: Me; onChanged: (me: Me | undefined) => void }) {
	return (
		<header className="flex items-center gap-3">
			<Face me={me} />

			<div className="flex min-w-0 flex-col">
				<span className="truncate font-medium text-fg">{me.name}</span>
				{/* The signature, which is the public half of an account and the
				    thing that proves a name in a room. Shown here because this is
				    the one page where somebody has a reason to read their own. */}
				<span className="readout text-fg-muted text-[12px]">{me.trip}</span>
			</div>

			<button
				type="button"
				onClick={async () => {
					await fetch("/api/account/session", {
						method: "DELETE",
						credentials: "same-origin",
					});
					onChanged(undefined);
				}}
				className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-fg-muted hover:bg-surface-hi hover:text-fg"
			>
				<LogOut className="size-3.5" />
				{t("Sign out")}
			</button>
		</header>
	);
}

function Face({ me }: { me: Me }) {
	if (me.avatar) {
		return <img src={me.avatar} alt="" className="size-12 shrink-0 rounded-full object-cover" />;
	}

	return (
		<span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-surface-hi text-fg-muted">
			{me.name.slice(0, 1).toUpperCase()}
		</span>
	);
}

/**
 * Choosing a picture.
 *
 * Scaled and re-encoded here rather than sent as it was chosen. A photograph off
 * a phone is several megabytes of a thing that will be drawn at forty-eight
 * pixels, and uploading it whole would mean holding it, serving it, and backing
 * it up forever for a picture nobody will ever see at that size.
 */
function Picture({ me, onChanged }: { me: Me; onChanged: (me: Me) => void }) {
	const file = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);

	const send = async (image: string | null) => {
		setBusy(true);

		try {
			const response = await fetch("/api/account/avatar", {
				method: image ? "PUT" : "DELETE",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				body: image ? JSON.stringify({ image }) : undefined,
			});

			if (!response.ok) throw new Error(t("That picture could not be used."));

			// Re-read rather than patched, and with a fresh query so the browser
			// does not show the picture it already had under the same address.
			const updated = (await response.json()) as Me;
			onChanged({ ...updated, avatar: updated.avatar ? `${updated.avatar}?${Date.now()}` : undefined });
		} catch (err) {
			actionFailed(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
			<h2 className="font-medium text-fg text-sm">{t("Picture")}</h2>
			<p className="text-fg-muted text-[11.5px]">
				{t("Shown beside your name in a call. Scaled down before it is sent.")}
			</p>

			<div className="mt-1 flex gap-2">
				<input
					ref={file}
					type="file"
					accept="image/*"
					className="hidden"
					onChange={async (event) => {
						const chosen = event.target.files?.[0];
						event.target.value = "";

						if (!chosen) return;

						try {
							await send(await shrink(chosen));
						} catch {
							actionFailed(t("That picture could not be used."));
						}
					}}
				/>

				<button
					type="button"
					disabled={busy}
					onClick={() => file.current?.click()}
					className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] hover:bg-surface-hi disabled:opacity-40"
				>
					{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Camera className="size-3.5" />}
					{t("Choose a picture")}
				</button>

				{me.avatar && (
					<button
						type="button"
						disabled={busy}
						onClick={() => void send(null)}
						className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-fg-muted hover:bg-surface-hi hover:text-danger disabled:opacity-40"
					>
						<Trash2 className="size-3.5" />
						{t("Remove")}
					</button>
				)}
			</div>
		</section>
	);
}

function Passphrase() {
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();

		if (busy) return;

		setBusy(true);

		try {
			const response = await fetch("/api/account/passphrase", {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify({ current, next }),
			});

			if (!response.ok) {
				const reason = (await response.json().catch(() => ({}))) as { error?: string };
				throw new Error(explain(reason.error));
			}

			setCurrent("");
			setNext("");
			setDone(true);
		} catch (err) {
			actionFailed(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<form
			onSubmit={submit}
			className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
		>
			<h2 className="font-medium text-fg text-sm">{t("Passphrase")}</h2>
			<p className="text-fg-muted text-[11.5px]">
				{t("This is how you are recognised, in a call and here. At least eight characters.")}
			</p>

			<div className="mt-1 flex flex-col gap-2">
				<Input
					type="password"
					value={current}
					onChange={(event) => setCurrent(event.target.value)}
					placeholder={t("Current passphrase")}
					aria-label={t("Current passphrase")}
					autoComplete="current-password"
				/>

				<Input
					type="password"
					value={next}
					onChange={(event) => setNext(event.target.value)}
					placeholder={t("New passphrase")}
					aria-label={t("New passphrase")}
					autoComplete="new-password"
				/>
			</div>

			<div className="mt-1 flex items-center gap-3">
				<button
					type="submit"
					disabled={busy || !current || next.length < 8}
					className={cn(
						"flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px]",
						"hover:bg-surface-hi disabled:opacity-40",
					)}
				>
					{busy && <Loader2 className="size-3.5 animate-spin" />}
					{t("Change it")}
				</button>

				{done && <span className="text-[11.5px] text-fg-muted">{t("Changed.")}</span>}
			</div>
		</form>
	);
}

/**
 * Making a link that lets somebody outside a scope into one of its rooms.
 *
 * Three things to say, all optional: the name the guest will wear, when the link
 * starts working, and when it stops. Leaving the end empty is a link that works
 * until somebody stops it, which is what a client who comes every week wants
 * and what a single call does not — so the line under the result says which
 * one was made, in the reader's clock.
 *
 * The times are typed into the browser's own picker and sent as instants. A
 * time with no zone is a time in a zone somebody guessed, and the guest the
 * link is for may be in another one.
 *
 * Stopping is here as well as making, for the same reason the links are: ending
 * a meeting does not take its links with it, so keeping somebody out of the
 * next one is something a member does from here, possibly days later. It stops
 * every link to the room, whoever made it, which is what the server does and
 * what the button says.
 */
function GuestLinks({ me }: { me: Me }) {
	const mine = me.scopes ?? [];

	const [typed, setTyped] = useState("");
	const [scope, setScope] = useState(mine[0] ?? "");
	const [name, setName] = useState("");
	const [from, setFrom] = useState("");
	const [until, setUntil] = useState("");
	const [busy, setBusy] = useState<"make" | "stop">();
	const [made, setMade] = useState<{ link: string; name?: string; from?: string; until?: string }>();
	const [copied, setCopied] = useState(false);

	// The room as the server will read it. An @ typed into the room half is
	// folded away rather than allowed to start a second scope: the scope is
	// chosen beside it, and a name that split two ways would be refused.
	const local = normaliseRoomName(typed.replace(/@/g, "-"));
	const full = `${local}@${scope}`;
	const usable = validRoomName(full) && validScope(scope);

	const path = `/api/rooms/${encodeURIComponent(full)}/invites`;

	const make = async (event: React.FormEvent) => {
		event.preventDefault();

		if (busy || !usable) return;

		setBusy("make");

		try {
			const response = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify({
					// Asked for by name. Without it the server makes the ordinary
					// kind, which goes when the meeting ends, as a link made in a
					// call does.
					standing: true,
					name: name.trim(),
					// The browser's picker gives a wall-clock time with no zone,
					// and Date reads that as this machine's. Sent as an instant.
					from: from ? new Date(from).toISOString() : "",
					until: until ? new Date(until).toISOString() : "",
				}),
			});

			if (!response.ok) {
				const reason = (await response.json().catch(() => ({}))) as { error?: string };
				throw new Error(explainLink(reason.error));
			}

			const said = (await response.json()) as { token: string; name?: string; from?: string; expires?: string };

			// The join page, wherever this deployment serves it, with the link's
			// token where the join reads it and the room where the page does.
			const url = new URL("/", window.location.href);
			url.search = `?invite=${encodeURIComponent(said.token)}`;
			url.hash = `#/${full}`;

			setMade({ link: url.toString(), name: said.name, from: said.from, until: said.expires });

			// Copied as well as shown, as the panel in a call does: whoever made
			// it is about to paste it somewhere.
			//
			// Not waited for. A browser can leave a clipboard write unanswered
			// while the page is not focused, and the form stayed busy behind it
			// with the link already on screen — which a headless run showed as a
			// spinner on a button whose work was done.
			void navigator.clipboard.writeText(url.toString()).then(
				() => setCopied(true),
				() => setCopied(false),
			);
		} catch (err) {
			actionFailed(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(undefined);
		}
	};

	const stop = async () => {
		if (busy || !usable) return;

		setBusy("stop");

		try {
			const response = await fetch(path, { method: "DELETE", credentials: "same-origin" });

			if (!response.ok) {
				const reason = (await response.json().catch(() => ({}))) as { error?: string };
				throw new Error(explainLink(reason.error));
			}

			const said = (await response.json().catch(() => ({}))) as { revoked?: number };
			const gone = typeof said.revoked === "number" ? said.revoked : 0;

			setMade(undefined);
			actionDone(
				gone === 1 ? t("One link stopped working.") : t("{count} links stopped working.", { count: String(gone) }),
			);
		} catch (err) {
			actionFailed(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(undefined);
		}
	};

	const field = "rounded-md border border-border bg-surface-hi px-2.5 py-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40";

	return (
		<form onSubmit={make} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
			<h2 className="font-medium text-fg text-sm">{t("Guest links")}</h2>
			<p className="text-fg-muted text-[11.5px]">
				{t("A link lets somebody outside your scope into one of its rooms as a guest. Leave the end empty for a link that works until it is stopped.")}
			</p>

			<div className="mt-1 flex items-center gap-1.5">
				<input
					value={typed}
					onChange={(event) => setTyped(event.target.value)}
					placeholder={t("Room name")}
					aria-label={t("Room name")}
					className={cn(field, "readout min-w-0 flex-1")}
				/>

				<span className="readout text-fg-muted text-[12.5px]">@</span>

				{/* Typed by an administrator, who belongs to every scope; chosen by
				    anybody else from the ones on their account, and simply named
				    where there is only one. */}
				{me.admin ? (
					<input
						value={scope}
						onChange={(event) => setScope(event.target.value.toLowerCase().trim())}
						placeholder={t("Scope")}
						aria-label={t("Scope")}
						list="my-scopes"
						maxLength={MAX_SCOPE}
						className={cn(field, "readout w-32")}
					/>
				) : mine.length > 1 ? (
					<select
						value={scope}
						onChange={(event) => setScope(event.target.value)}
						aria-label={t("Scope")}
						className={cn(field, "readout")}
					>
						{mine.map((one) => (
							<option key={one} value={one}>
								{one}
							</option>
						))}
					</select>
				) : (
					<span className="readout text-fg text-[12.5px]">{scope}</span>
				)}

				<datalist id="my-scopes">
					{mine.map((one) => (
						<option key={one} value={one} />
					))}
				</datalist>
			</div>

			<input
				value={name}
				onChange={(event) => setName(event.target.value)}
				placeholder={t("Their name, if the link is for one person")}
				aria-label={t("Their name, if the link is for one person")}
				maxLength={40}
				className={field}
			/>

			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
				<label className="flex flex-col gap-1">
					<span className="text-fg-muted text-[11px]">{t("Works from")}</span>
					<input
						type="datetime-local"
						value={from}
						onChange={(event) => setFrom(event.target.value)}
						className={field}
					/>
				</label>

				<label className="flex flex-col gap-1">
					<span className="text-fg-muted text-[11px]">{t("Works until")}</span>
					<input
						type="datetime-local"
						value={until}
						onChange={(event) => setUntil(event.target.value)}
						className={field}
					/>
				</label>
			</div>

			<div className="mt-1 flex flex-wrap items-center gap-2">
				<button
					type="submit"
					disabled={busy !== undefined || !usable}
					className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] hover:bg-surface-hi disabled:opacity-40"
				>
					{busy === "make" ? <Loader2 className="size-3.5 animate-spin" /> : <Link2 className="size-3.5" />}
					{t("Make a link")}
				</button>

				<button
					type="button"
					onClick={() => void stop()}
					disabled={busy !== undefined || !usable}
					className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] text-fg-muted hover:bg-danger/10 hover:text-fg disabled:opacity-40"
				>
					{busy === "stop" ? <Loader2 className="size-3.5 animate-spin" /> : <Link2Off className="size-3.5" />}
					{t("Stop every link to this room working")}
				</button>
			</div>

			{made && (
				<div className="mt-1 flex flex-col gap-1.5">
					<div className="flex items-start gap-1.5">
						<p className="readout min-w-0 flex-1 break-all rounded-md bg-surface-hi px-2 py-1.5 text-[11px] text-fg-muted">
							{made.link}
						</p>

						<button
							type="button"
							onClick={() =>
								void navigator.clipboard.writeText(made.link).then(
									() => setCopied(true),
									() => setCopied(false),
								)
							}
							aria-label={copied ? t("Link copied") : t("Copy link")}
							className="rounded-md border border-border p-1.5 text-fg-muted hover:bg-surface-hi hover:text-fg"
						>
							{copied ? <Check className="size-3.5 text-tally" /> : <Copy className="size-3.5" />}
						</button>
					</div>

					<p className="text-fg-muted text-[11.5px] leading-snug">
						{made.until
							? made.from
								? t("This link works from {from} until {until}.", {
										from: whenSaid(made.from),
										until: whenSaid(made.until),
									})
								: t("This link works until {until}.", { until: whenSaid(made.until) })
							: made.from
								? t("This link works from {from} until somebody stops it.", { from: whenSaid(made.from) })
								: t("This link works until somebody stops it.")}{" "}
						{made.name && t("Whoever uses it joins as {name}.", { name: made.name })}
					</p>
				</div>
			)}
		</form>
	);
}

/** What a link could not be made for, in the reader's language. */
function explainLink(reason: string | undefined): string {
	switch (reason) {
		case "not_yours":
			return t("You can make links only into rooms of your own scopes.");
		case "name_too_long":
			return t("That name is too long.");
		case "bad_time":
			return t("That window cannot be used. It has to end after it starts, and after now.");
		case "invalid_room":
			return t("Room names can only use lowercase letters, numbers and dashes.");
		case "rate_limited":
			return t("Too many attempts. Try again in a moment.");
		default:
			return t("That link could not be made. Try again.");
	}
}

/** The server sends a code; the sentence belongs here, in the reader's language. */
function explain(reason: string | undefined): string {
	switch (reason) {
		case "not_yours":
			return t("That is not your current passphrase.");
		case "passphrase_too_short":
			return t("At least eight characters.");
		case "passphrase_unchanged":
			return t("That is the passphrase you already have.");
		case "passphrase_in_use":
			return t("Somebody else already uses that passphrase. Choose another.");
		default:
			return t("That could not be changed. Try again.");
	}
}

/**
 * Scale a chosen image down to something worth storing.
 *
 * Two hundred and fifty-six pixels square, cropped to the middle, and encoded
 * as JPEG at a quality nobody will notice at the size it is drawn. A photograph
 * off a phone arrives as several megabytes; what leaves here is a few tens of
 * kilobytes, which is the difference between a database somebody can copy and
 * one they cannot.
 */
async function shrink(file: File): Promise<string> {
	const bitmap = await createImageBitmap(file);

	const side = Math.min(bitmap.width, bitmap.height);
	const canvas = document.createElement("canvas");
	canvas.width = 256;
	canvas.height = 256;

	const context = canvas.getContext("2d");
	if (!context) throw new Error("no canvas");

	context.drawImage(
		bitmap,
		(bitmap.width - side) / 2,
		(bitmap.height - side) / 2,
		side,
		side,
		0,
		0,
		256,
		256,
	);

	bitmap.close();

	return canvas.toDataURL("image/jpeg", 0.82);
}
