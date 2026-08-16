import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { t } from "@/live/i18n";
import { actionFailed } from "@/live/notices";
import { Camera, Loader2, LogOut, Trash2, UserRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Somebody's own account: their passphrase and their picture.
 *
 * Nothing else, and that is the design rather than the current state of it.
 * Everything else on this deployment — the relays, the rooms, who else may be
 * here — belongs to whoever runs it, and a page that grew a second column for
 * some people and not others would be one mistake away from showing the wrong
 * person the wrong thing.
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
		<main className="mx-auto flex min-h-full max-w-lg flex-col gap-4 bg-bg p-6 text-fg">
			<Header me={me} onChanged={setMe} />
			<Picture me={me} onChanged={setMe} />
			<Passphrase />

			<p className="px-1 text-fg-muted text-[11.5px] leading-relaxed">
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
			<form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4">
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
				className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-fg-muted hover:bg-surface-2 hover:text-fg"
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
		<span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-surface-2 text-fg-muted">
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
					className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] hover:bg-surface-2 disabled:opacity-40"
				>
					{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Camera className="size-3.5" />}
					{t("Choose a picture")}
				</button>

				{me.avatar && (
					<button
						type="button"
						disabled={busy}
						onClick={() => void send(null)}
						className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-fg-muted hover:bg-surface-2 hover:text-danger disabled:opacity-40"
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
						"hover:bg-surface-2 disabled:opacity-40",
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
