import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_ROOM_NAME, looksGenerated, normaliseRoomName, validRoomName } from "@/live/names";
import { Check, Copy, Link2, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * The room, shown and changeable before joining.
 *
 * One control does the work of two: it arrives holding a generated name, which
 * is a new meeting, and typing over it is joining somebody else's. Splitting
 * that into "new" and "join" would be two buttons, two screens, and two pieces
 * of copy for what is one decision about where to go.
 */
export function RoomBar({ room, onChange }: { room: string; onChange: (room: string) => void }) {
	const [editing, setEditing] = useState(false);
	const [copied, setCopied] = useState(false);
	const field = useRef<HTMLInputElement>(null);

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
		<div className="space-y-2">
			<div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
				<Link2 className="size-4 shrink-0 text-fg-muted" />

				{editing ? (
					<Input
						ref={field}
						defaultValue={room}
						aria-label="Room name"
						maxLength={MAX_ROOM_NAME}
						className="h-7 border-0 bg-transparent px-0 font-mono text-sm focus-visible:ring-0"
						onChange={(event) => {
							// Normalised as they type, so a character the server
							// would reject is something they watch not happen
							// rather than an error afterwards.
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
					<button
						type="button"
						onClick={() => setEditing(true)}
						title="Change room"
						className="group flex min-w-0 flex-1 items-center gap-1.5 text-left"
					>
						<span className="truncate font-mono text-sm">{room}</span>
						<Pencil className="size-3 shrink-0 text-fg-muted opacity-0 transition-opacity group-hover:opacity-100" />
					</button>
				)}

				<Button
					variant="ghost"
					size="icon"
					className="size-7 shrink-0"
					aria-label={copied ? "Link copied" : "Copy the link to this room"}
					onClick={copy}
				>
					{copied ? <Check className="text-speaking" /> : <Copy />}
				</Button>
			</div>

			{/* Said only about a name somebody chose. A generated one is not worth
			    guessing at, and saying so about every room would train people to
			    stop reading it. */}
			{!looksGenerated(room) && (
				<p className="text-fg-muted text-xs">
					Anybody who guesses this name can join. Names that were generated rather than chosen
					are not worth guessing at.
				</p>
			)}
		</div>
	);
}
