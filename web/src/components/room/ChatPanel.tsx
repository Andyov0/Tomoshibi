import { Button } from "@/components/ui/button";
import type { Said } from "@/live/chat";
import { cn } from "@/lib/utils";
import { ArrowUp, MessageSquareOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Everything said this call.
 *
 * Floats over the room rather than pushing it aside. Pushing looks considerate
 * until you try it: the grid is computed from its container, so opening the
 * panel moves and resizes every tile at once because one person wanted to type.
 * Covering one corner is the smaller disturbance, and it is reversible in a way
 * a relayout is not.
 */
export function ChatPanel({
	said,
	onSay,
	onClose,
}: {
	said: Said[];
	onSay: (body: string) => void;
	onClose: () => void;
}) {
	const [draft, setDraft] = useState("");
	const field = useRef<HTMLTextAreaElement>(null);
	const log = useRef<HTMLDivElement>(null);

	useEffect(() => field.current?.focus(), []);

	// Stay at the newest. A conversation is read from where it left off.
	useEffect(() => {
		const view = log.current;
		if (view) view.scrollTop = view.scrollHeight;
	}, [said.length]);

	const send = () => {
		const body = draft.trim();
		if (!body) return;

		onSay(body);
		setDraft("");
	};

	return (
		<aside
			className={cn(
				"absolute right-3 bottom-3 z-20 flex w-66 flex-col overflow-hidden",
				"max-h-[min(26rem,calc(100%-5.5rem))] rounded-xl border border-border",
				"bg-surface/95 shadow-2xl backdrop-blur-md",
			)}
		>
			<header className="flex items-center justify-between border-border border-b px-3 py-2">
				<strong className="font-semibold text-[12.5px]">Messages</strong>
				<Button variant="ghost" size="icon" className="size-6" aria-label="Close messages" onClick={onClose}>
					<X className="size-3.5" />
				</Button>
			</header>

			{said.length === 0 ? (
				<Empty />
			) : (
				<div ref={log} className="flex flex-1 flex-col justify-end gap-2.5 overflow-y-auto p-3">
					{said.map((one, index) => {
						// A run from one person drops the name: the column is
						// narrow and repeating it says nothing new.
						const run = index > 0 && said[index - 1]?.from === one.from;

						return (
							<div key={one.id} className={cn("flex flex-col gap-0.5", run && "-mt-2")}>
								{!run && (
									<span className="flex items-baseline gap-1.5 font-medium text-[11.5px]">
										{one.name}
										{one.mine && <span className="font-normal text-fg-muted">(you)</span>}
										<span className="readout text-[9.5px] text-fg-muted">{clock(one.at)}</span>
									</span>
								)}
								<span className="break-words text-[12.5px] leading-normal">{one.body}</span>
							</div>
						);
					})}
				</div>
			)}

			<div className="m-3 flex items-end gap-2 rounded-lg border border-border bg-white/2 px-2.5 py-1.5">
				<textarea
					ref={field}
					rows={1}
					value={draft}
					placeholder="Say something"
					aria-label="Say something"
					maxLength={2000}
					onChange={(event) => {
						setDraft(event.target.value);
						// Grows with the message and stops: past a few lines this
						// is a document, and a call is not where one gets written.
						event.target.style.height = "auto";
						event.target.style.height = `${Math.min(event.target.scrollHeight, 96)}px`;
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							send();
						}
					}}
					className={cn(
						"flex-1 resize-none bg-transparent py-1 text-[12.5px] text-fg outline-none",
						"placeholder:text-fg-muted",
					)}
				/>

				<Button
					size="icon"
					className="size-6 shrink-0 rounded-md"
					aria-label="Send"
					disabled={!draft.trim()}
					onClick={send}
				>
					<ArrowUp className="size-3" />
				</Button>
			</div>
		</aside>
	);
}

/**
 * Nothing has been said yet.
 *
 * The empty state carries the one fact somebody needs before they type: this is
 * not written down anywhere. Whether that is true and whether it looks true are
 * different things, and only the second one stops a person posting something
 * they would rather not leave behind.
 */
function Empty() {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
			<MessageSquareOff className="size-6 text-border" />
			<p className="max-w-[24ch] text-[11.5px] text-fg-muted leading-relaxed">
				Messages last as long as the call. Nothing is written down.
			</p>
		</div>
	);
}

/** Wall-clock time, to the minute: seconds are noise in a conversation. */
function clock(at: number): string {
	return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
