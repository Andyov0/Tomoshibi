import { LanguagePicker } from "@/components/room/LanguagePicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/useT";
import type { Me } from "@/live/account";
import { signIn, signOut } from "@/live/account";
import { generateRoomName, normaliseRoomName, validRoomName } from "@/live/names";
import { actionFailed } from "@/live/notices";
import { cn } from "@/lib/utils";
import { LogOut, Plus, UserRound, Video } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";

/*
The two screens in front of a call, on a deployment that does not let strangers
open rooms.

The page used to put somebody straight into a room with a generated name, which
is the right thing when anybody may start one: the fastest path to a meeting is
to already be in it. It is the wrong thing when they may not, because the first
thing that happens is a refusal, and the refusal arrives after they have chosen a
camera and typed a name.

So where opening a room is restricted, the order is inverted: say who you are,
then say what you want. Two choices and not a form, because they are genuinely
different errands — starting a meeting is a decision and joining one is following
an instruction somebody else gave you — and a single box asking for a room name
serves the second and quietly fails the first.

None of this appears on a deployment that lets anyone open a room. There the old
page is correct and this would be a door in front of an open gate.
*/

/** The shell both screens sit in, so the corner is in the same place on each. */
function Frame({ children, me, onSignedOut }: { children: ReactNode; me?: Me; onSignedOut?: () => void }) {
	const t = useT();

	return (
		<main className="flex min-h-full flex-col gap-6 p-5 sm:p-6">
			<header className="flex items-center justify-between gap-4">
				<div className="flex items-center gap-2">
					<img src="/favicon.svg" alt="" className="size-5 rounded-[5px]" />
					<span className="font-semibold text-[13px] tracking-tight">Tomoshibi</span>
				</div>

				<div className="flex items-center gap-2">
					{me && (
						<>
							{/* Their own page, and the way out. Both in the corner
							    rather than on the choices below, which are about the
							    meeting and should not be sharing a row with account
							    housekeeping. */}
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
								<span className="hidden sm:inline">{me.name}</span>
							</a>

							<button
								type="button"
								onClick={async () => {
									await signOut();
									onSignedOut?.();
								}}
								aria-label={t("Sign out")}
								title={t("Sign out")}
								className="rounded-md border border-border p-1.5 text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
							>
								<LogOut className="size-3.5" />
							</button>
						</>
					)}

					<LanguagePicker />
				</div>
			</header>

			<div className="flex flex-1 items-center justify-center">{children}</div>
		</main>
	);
}

/** Say who you are. */
export function SignIn({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
	const t = useT();
	const [name, setName] = useState("");
	const [passphrase, setPassphrase] = useState("");
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
		<Frame>
			<form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4">
				<header className="flex flex-col gap-1.5 text-center">
					<h1 className="font-semibold text-xl tracking-tight">{t("Sign in")}</h1>
					<p className="text-fg-muted text-sm leading-snug">
						{t("This deployment does not let just anybody start a meeting. If you were sent a link, open it instead.")}
					</p>
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
					{t("Sign in")}
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

	const wanted = normaliseRoomName(typed);

	return (
		<Frame me={me} onSignedOut={onSignedOut}>
			<div className="flex w-full max-w-md flex-col gap-3">
				{/*
				  * Starting one first, and as a press rather than a field.
				  * Naming a new meeting is a decision nobody wants to make in
				  * order to have one — the name is generated, and anybody who
				  * cares can rename it on the next screen, where they can see it.
				  */}
				<button
					type="button"
					onClick={() => onOpen(generateRoomName())}
					className={cn(
						"flex items-center gap-3 rounded-xl border border-border bg-surface p-4 text-left",
						"transition-colors hover:border-fg/20 hover:bg-surface-hi",
					)}
				>
					<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-tally/15 text-fg">
						<Plus className="size-4.5" />
					</span>

					<span className="flex flex-col gap-0.5">
						<span className="font-medium text-[14px]">{t("Start a meeting")}</span>
						<span className="text-fg-muted text-[12px] leading-snug">
							{t("A new room with a name nobody has used.")}
						</span>
					</span>
				</button>

				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (validRoomName(wanted)) onOpen(wanted);
					}}
					className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4"
				>
					<span className="flex items-center gap-3">
						<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">
							<Video className="size-4.5" />
						</span>

						<span className="flex flex-col gap-0.5">
							<span className="font-medium text-[14px]">{t("Join a meeting")}</span>
							<span className="text-fg-muted text-[12px] leading-snug">
								{t("The name you were given.")}
							</span>
						</span>
					</span>

					<div className="flex gap-2">
						<Input
							value={typed}
							onChange={(event) => setTyped(event.target.value)}
							placeholder={t("Room name")}
							aria-label={t("Room name")}
							maxLength={64}
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
