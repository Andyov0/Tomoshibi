import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { type Opening, deployment } from "@/live/api";
import { MAX_ROOM_NAME, looksGenerated, normaliseRoomName, validRoomName } from "@/live/names";
import { Check, Copy, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * The room, which is what this screen is about.
 *
 * Set as the heading rather than shown in a bordered row above the picture. The
 * name is the only thing that makes the screen mean anything — it is where the
 * call is, it is what somebody was sent, and it is the credential — so it is
 * given the size of the thing it is instead of the size of a caption.
 *
 * In the monospace this interface keeps for anything a machine produced, beside
 * the timestamps and the signatures. Nobody chose these letters and reading them
 * to somebody over a telephone is what they are for.
 *
 * One control still does the work of two: it arrives holding a generated name,
 * which is a new meeting, and typing over it is joining somebody else's.
 */
/**
 * The room somebody is about to walk into, and — where it is still a question —
 * a way to change it.
 *
 * `fixed` is somebody holding an invitation. The room was decided by whoever
 * sent it and the link is what admits them, so renaming it is not a choice they
 * have: it walks them to a different room with a key for this one, and the
 * server refuses. PreJoin's own documentation says the passphrase field goes for
 * a guest "and so does the ability to rename the room out from under the
 * invitation" — only the first half was ever written.
 */
export function RoomTitle({
	room,
	onChange,
	fixed = false,
}: { room: string; onChange: (room: string) => void; fixed?: boolean }) {
	const t = useT();
	const [editing, setEditing] = useState(false);
	const [copied, setCopied] = useState(false);
	const [opening, setOpening] = useState<Opening>("anyone");
	const field = useRef<HTMLInputElement>(null);

	// Asked once, here, because this is the only line on the screen it changes.
	// Starting at the answer every deployment has until somebody changes it, so
	// nothing flickers between two sentences while the request is out.
	useEffect(() => {
		let live = true;

		void deployment().then((said) => {
			if (live) setOpening(said.openedBy);
		});

		return () => {
			live = false;
		};
	}, []);

	useEffect(() => {
		if (editing) field.current?.select();
	}, [editing]);

	// Reset by the effect rather than a timer left dangling: a component that
	// unmounts mid-flash should not schedule a state update into nothing.
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1600);
		return () => clearTimeout(timer);
	}, [copied]);

	const copy = () => {
		// The address bar's own text, never one assembled here: a hand-built URL
		// is right until the first deployment that puts this behind a path or a
		// different port.
		navigator.clipboard
			.writeText(window.location.href)
			.then(() => setCopied(true))
			.catch(() => setCopied(false));
	};

	return (
		<div className="flex flex-col gap-1.5">
			{editing ? (
				<Input
					ref={field}
					defaultValue={room}
					aria-label={t("Room name")}
					maxLength={MAX_ROOM_NAME}
					className="h-9 font-mono text-base"
					onChange={(event) => {
						// Normalised as they type, so a character the server would
						// refuse is something they watch not happen rather than an
						// error afterwards.
						const cleaned = normaliseRoomName(event.target.value);
						event.target.value = cleaned;
						if (validRoomName(cleaned)) onChange(cleaned);
					}}
					onBlur={() => setEditing(false)}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === "Escape") {
							event.preventDefault();
							setEditing(false);
						}
					}}
				/>
			) : (
				// Aligned to the top rather than the middle, because the name is
				// allowed to take two lines and buttons centred across both would
				// float beside nothing.
				<div className="flex items-start gap-1">
					<button
						type="button"
						onClick={() => !fixed && setEditing(true)}
						disabled={fixed}
						title={fixed ? undefined : t("Change room")}
						className={cn(
							"readout min-w-0 flex-1 text-left text-[17px] leading-tight tracking-tight sm:text-[19px]",
							"rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-fg/70",
						)}
					>
						{/*
						 * Wrapped rather than truncated. The longest name this
						 * generates is thirty-three characters, which overflows a
						 * phone at any size worth reading — and a room name with its
						 * end hidden is a credential somebody cannot repeat. It
						 * breaks at its own dashes without being asked.
						 */}
						{room}
					</button>

					{/* Gone rather than disabled: a control somebody cannot use is a
					    question they will ask, and there is no answer that helps
					    them. The name is a heading for this person. */}
					{!fixed && (
						<Button
							variant="ghost"
							size="icon"
							className="-mt-0.5 size-7 shrink-0"
							aria-label={t("Change room")}
							onClick={() => setEditing(true)}
						>
							<Pencil className="size-3.5" />
						</Button>
					)}

					<Button
						variant="ghost"
						size="icon"
						className="-mt-0.5 size-7 shrink-0"
						aria-label={copied ? t("Link copied") : t("Copy link")}
						onClick={copy}
					>
						{copied ? <Check className="size-3.5 text-tally" /> : <Copy className="size-3.5" />}
					</Button>
				</div>
			)}

			{/* One line at most, and never two. Both of these are about what this
			    name is worth, and somebody reading a paragraph under a heading
			    reads the first sentence or none. */}
			{opening === "admins" ? (
				<p className="text-fg-muted text-xs leading-snug">
					{t("Only administrators can start new rooms. Enter the name you were given.")}
				</p>
			) : opening === "signed" ? (
				// The middle setting, and the one that needs saying most. A new
				// name is refused without a passphrase, and until this line
				// existed the only way to find that out was to press Join and be
				// turned away with no explanation of what would have worked.
				<p className="text-fg-muted text-xs leading-snug">
					{t("Set a passphrase to start a new room. Anybody can join one that already exists.")}
				</p>
			) : (
				// Said only about a name somebody chose. A generated one is not
				// worth guessing at, and saying so about every room would train
				// people to stop reading it.
				!looksGenerated(room) && (
					<p className="text-fg-muted text-xs leading-snug">
						{t("Anyone who guesses this name can join.")}
					</p>
				)
			)}
		</div>
	);
}
