import { LanguagePicker } from "@/components/room/LanguagePicker";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/useT";
import type { Me } from "@/live/account";
import { signIn, signOut } from "@/live/account";
import { generateRoomName, normaliseRoomName, validRoomName } from "@/live/names";
import { actionFailed } from "@/live/notices";
import { cn } from "@/lib/utils";
import {
	ArrowRight,
	Eye,
	EyeOff,
	KeyRound,
	Loader2,
	LogOut,
	Plus,
	Shield,
	UserRound,
} from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";

/*
The two screens in front of a call, on a deployment that does not let strangers
open rooms.

The page used to put somebody straight into a room with a generated name, which
is the right thing when anybody may start one: the fastest path to a meeting is
to already be in it. It is the wrong thing when they may not, because then the
first thing that happens is a refusal, and it arrives after they have chosen a
camera and typed a name.

So where opening a room is restricted, the order inverts: say who you are, then
say what you want. Two choices rather than a form, because they are genuinely
different errands — starting a meeting is a decision, joining one is following an
instruction somebody else gave you — and a single box asking for a room name
serves the second and quietly fails the first.

Neither screen appears on a deployment that lets anyone open a room. There the
old page is right and this would be a door in front of an open gate.

Both are one card on an empty screen, which is a harder thing to make look
deliberate than a busy one: there is nothing else to be in proportion to. So the
ground carries a single warm glow behind the card, everything arrives in an
order, and the corner holds only what somebody might actually want from a page
they are passing through.
*/

/**
 * The shell both screens sit in.
 *
 * A grid rather than nested flex boxes, and centred by the grid rather than by
 * the child: the header is placed in its own row instead of being a sibling the
 * content has to make room for, so the card is centred in the window and not in
 * whatever is left over below the header. That distinction is invisible until
 * the header grows a second control, at which point everything below it slides.
 */
function Frame({ children, corner }: { children: ReactNode; corner?: ReactNode }) {
	return (
		<main className="relative grid min-h-full grid-rows-[auto_1fr] overflow-hidden">
			{/*
			 * One glow, high and behind everything, in the signal colour at a
			 * fraction of its strength. It is doing the work a photograph would do
			 * on a marketing page and is a hundredth of the weight: it gives the
			 * screen a top and a bottom, so a single card reads as placed rather
			 * than as stranded.
			 */}
			<div
				aria-hidden
				className={cn(
					"pointer-events-none absolute inset-x-0 top-0 h-[45vh]",
					"bg-[radial-gradient(60%_100%_at_50%_0%,var(--color-tally)_0%,transparent_70%)]",
					"opacity-[0.07]",
				)}
			/>

			<header className="z-10 flex items-center justify-between gap-4 p-5 sm:p-6">
				<div className="flex items-center gap-2">
					<img src="/favicon.svg" alt="" className="size-5 rounded-[5px]" />
					<span className="font-semibold text-[13px] tracking-tight">Tomoshibi</span>
				</div>

				<div className="flex items-center gap-2">{corner}</div>
			</header>

			<div className="z-10 flex items-start justify-center px-5 pb-16 sm:px-6">
				{/* Lifted off dead centre. Optical centre sits above geometric
				    centre, and a card placed at exactly half the height reads as
				    having sunk. */}
				<div className="w-full max-w-sm pt-[6vh] sm:pt-[10vh]">{children}</div>
			</div>
		</main>
	);
}

/** The corner of a page somebody is signed in on. */
function Corner({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
	const t = useT();

	return (
		<>
			{/*
			 * The way to the management pages, for the people who have them.
			 *
			 * Somebody who administers this deployment should not have to remember
			 * an address, and this is the page they are already looking at. Shown
			 * only to them: the button is not what authorises anything — the
			 * management pages ask the administrator list themselves — but a
			 * button everybody can see and nobody else can use is a door that
			 * invites knocking.
			 */}
			{me.admin && (
				<a
					href="/admin"
					className={cn(
						"flex items-center gap-1.5 rounded-md border border-tally/30 bg-tally/10 px-2.5 py-1.5",
						"text-[12px] text-fg transition-colors hover:bg-tally/20",
					)}
				>
					<Shield className="size-3.5 text-tally" />
					<span className="hidden sm:inline">{t("Admin console")}</span>
				</a>
			)}

			<a
				href="/account"
				className={cn(
					"flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5",
					"text-[12px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg",
				)}
			>
				{me.avatar ? (
					<img src={me.avatar} alt="" className="size-4 rounded-full object-cover" />
				) : (
					<UserRound className="size-3.5" />
				)}
				<span className="hidden max-w-32 truncate sm:inline">{me.name}</span>
			</a>

			<button
				type="button"
				onClick={async () => {
					await signOut();
					onSignedOut();
				}}
				aria-label={t("Sign out")}
				title={t("Sign out")}
				className="rounded-md border border-border p-1.5 text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
			>
				<LogOut className="size-3.5" />
			</button>

			<LanguagePicker />
		</>
	);
}

/** Say who you are. */
export function SignIn({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
	const t = useT();
	const [name, setName] = useState("");
	const [passphrase, setPassphrase] = useState("");
	const [shown, setShown] = useState(false);
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();

		if (busy) return;

		setBusy(true);

		try {
			onSignedIn(await signIn(name, passphrase));
		} catch {
			actionFailed(t("That name and passphrase do not go together."));
			// Cleared for the next attempt. A refused attempt is something that
			// happened rather than something still true.
			setPassphrase("");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Frame corner={<LanguagePicker />}>
			<form onSubmit={submit} className="flex flex-col gap-5">
				<header className="animate-rise flex flex-col gap-2">
					<h1 className="font-semibold text-[22px] tracking-tight">{t("Sign in")}</h1>
					<p className="text-fg-muted text-[13px] leading-relaxed">
						{t("Meetings here are started by the people who belong here. If somebody sent you a link, open that instead.")}
					</p>
				</header>

				{/*
				 * One box holding two fields, rather than two boxes.
				 *
				 * They are one answer — a name is not a credential and a passphrase
				 * without a name is not either — and the same pairing is used on the
				 * join screen, so somebody who has been here before recognises the
				 * shape before reading a word of it.
				 */}
				<div
					className={cn(
						"animate-rise [animation-delay:60ms]",
						"divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface",
						"transition-[border-color,box-shadow]",
						"focus-within:border-fg/40 focus-within:ring-2 focus-within:ring-fg/25",
					)}
				>
					<label className="relative flex items-center">
						<UserRound className="pointer-events-none absolute left-3.5 size-4 text-fg-muted" />
						<input
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder={t("Name")}
							aria-label={t("Name")}
							autoComplete="username"
							// biome-ignore lint/a11y/noAutofocus: the page exists to be typed into
							autoFocus
							maxLength={32}
							className="h-12 w-full bg-transparent pr-3.5 pl-10 text-fg text-sm outline-none placeholder:text-fg-muted"
						/>
					</label>

					<label className="relative flex items-center">
						<KeyRound
							className={cn(
								"pointer-events-none absolute left-3.5 size-4 transition-colors",
								passphrase ? "text-tally" : "text-fg-muted",
							)}
						/>
						<input
							type={shown ? "text" : "password"}
							value={passphrase}
							onChange={(event) => setPassphrase(event.target.value)}
							placeholder={t("Passphrase")}
							aria-label={t("Passphrase")}
							autoComplete="current-password"
							maxLength={200}
							className={cn(
								"h-12 w-full bg-transparent pl-10 text-fg text-sm outline-none placeholder:text-fg-muted",
								passphrase ? "pr-11" : "pr-3.5",
							)}
						/>

						{/* Only once there is something to look at. An eye beside an
						    empty field is a control offering to reveal nothing. */}
						{passphrase && (
							<button
								type="button"
								onClick={() => setShown((was) => !was)}
								aria-label={shown ? t("Hide passphrase") : t("Show passphrase")}
								aria-pressed={shown}
								className="absolute right-3 grid size-6 place-items-center rounded text-fg-muted transition-colors hover:text-fg"
							>
								{shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
							</button>
						)}
					</label>
				</div>

				<Button
					type="submit"
					variant="primary"
					size="lg"
					disabled={busy || !name || !passphrase}
					className="animate-rise [animation-delay:120ms]"
				>
					{busy ? <Loader2 className="size-4 animate-spin" /> : t("Sign in")}
				</Button>
			</form>
		</Frame>
	);
}

/** Say what you want. */
export function Lobby({
	me,
	onOpen,
	onSignedOut,
}: {
	me: Me;
	onOpen: (room: string) => void;
	onSignedOut: () => void;
}) {
	const t = useT();
	const [typed, setTyped] = useState("");
	const [naming, setNaming] = useState("");

	const wanted = normaliseRoomName(typed);
	const opening = normaliseRoomName(naming);

	return (
		<Frame corner={<Corner me={me} onSignedOut={onSignedOut} />}>
			<div className="flex flex-col gap-5">
				<header className="animate-rise flex flex-col gap-1">
					<h1 className="font-semibold text-[22px] tracking-tight">
						{t("Hello, {name}", { name: me.name })}
					</h1>
					<p className="text-fg-muted text-[13px]">{t("What would you like to do?")}</p>
				</header>

				{/*
				 * Naming the new meeting, with the generated name as the answer to
				 * leaving it blank rather than as the only answer.
				 *
				 * It used to generate one outright, on the reasoning that naming a
				 * meeting is a decision nobody wants to make in order to have one.
				 * That is true of most meetings and wrong about the ones people
				 * hold every week: a recurring call has a name its people already
				 * know, and being handed "crisp-bough-thrive-4185" instead means
				 * telling everybody a new one each time. So the field is offered
				 * and is not required, which serves both without asking anybody
				 * which they are.
				 */}
				<form
					onSubmit={(event) => {
						event.preventDefault();
						onOpen(validRoomName(opening) ? opening : generateRoomName());
					}}
					className={cn(
						"animate-rise [animation-delay:60ms]",
						"flex flex-col gap-3 rounded-xl border border-border bg-surface p-4",
					)}
				>
					<span className="flex items-center gap-3.5">
						<span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-tally/15 text-tally">
							<Plus className="size-5" />
						</span>

						<span className="flex min-w-0 flex-col gap-0.5">
							<span className="font-medium text-[14px]">{t("Start a meeting")}</span>
							<span className="text-[12px] text-fg-muted leading-snug">
								{t("Name it yourself, or leave it blank for one nobody has used.")}
							</span>
						</span>
					</span>

					<div className="flex gap-2">
						<input
							value={naming}
							onChange={(event) => setNaming(event.target.value)}
							placeholder={t("Room name")}
							aria-label={t("Name for the new room")}
							maxLength={64}
							className={cn(
								"h-10 min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-3 text-sm text-fg",
								"outline-none transition-[border-color,box-shadow] placeholder:text-fg-muted",
								"focus-visible:border-fg/40 focus-visible:ring-2 focus-visible:ring-fg/25",
							)}
						/>

						<Button
							type="submit"
							variant="primary"
							// Never disabled. Blank is an answer here, and a button
							// that greys out until a field is filled says the field
							// is required when it is the opposite.
							className="group gap-1.5"
						>
							{t("Start")}
							<ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
						</Button>
					</div>
				</form>

				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (validRoomName(wanted)) onOpen(wanted);
					}}
					className={cn(
						"animate-rise [animation-delay:120ms]",
						"flex flex-col gap-3 rounded-xl border border-border bg-surface p-4",
					)}
				>
					<span className="flex items-center gap-3.5">
						<span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-hi text-fg-muted">
							<Eye className="size-5" />
						</span>

						<span className="flex min-w-0 flex-col gap-0.5">
							<span className="font-medium text-[14px]">{t("Join a meeting")}</span>
							<span className="text-[12px] text-fg-muted leading-snug">
								{t("The name you were given.")}
							</span>
						</span>
					</span>

					<div className="flex gap-2">
						<input
							value={typed}
							onChange={(event) => setTyped(event.target.value)}
							placeholder={t("Room name")}
							aria-label={t("Room name")}
							maxLength={64}
							className={cn(
								"h-10 min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-3 text-sm text-fg",
								"outline-none transition-[border-color,box-shadow] placeholder:text-fg-muted",
								"focus-visible:border-fg/40 focus-visible:ring-2 focus-visible:ring-fg/25",
							)}
						/>

						<Button type="submit" variant="secondary" disabled={!validRoomName(wanted)}>
							{t("Join")}
						</Button>
					</div>
				</form>
			</div>
		</Frame>
	);
}
