import { Button } from "@/components/ui/button";
import { useVideoInfo } from "@/hooks/useVideoInfo";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { clock } from "@/live/music";
import { actionFailed } from "@/live/notices";
import {
	type Refusal,
	type TheatreDeps,
	type Video,
	closeTheatre,
	command,
	seenShow,
	startTheatre,
	subscribeShow,
} from "@/live/watch";
import { resolveVideo } from "@/live/watch-api";
import type { Room } from "livekit-client";
import { Clapperboard, Loader2, Plus, X } from "lucide-react";
import { type FormEvent, useState, useSyncExternalStore } from "react";

/** What to say about a link that was not added. */
export function refusal(why: Refusal): "That link is not a video that can be played here." | "That video cannot be played here." | "The video could not be read. Try again." {
	if (why === "not_a_video") return "That link is not a video that can be played here.";
	if (why === "unavailable") return "That video cannot be played here.";
	return "The video could not be read. Try again.";
}

/**
 * Add what a link plays to the show: started here when nobody runs one and
 * this person may, and otherwise asked of whoever runs it. True if it was
 * added, or sent to be.
 */
export async function addVideo(room: Room, text: string, ready: boolean, t: ReturnType<typeof useT>): Promise<boolean> {
	const show = seenShow(room)?.show;
	if (!show && ready) {
		const deps: TheatreDeps = {
			resolve: resolveVideo,
			onRefused: (why) => actionFailed(t(refusal(why))),
		};
		const theatre = startTheatre(room, deps);
		return theatre !== undefined && (await theatre.add(text, room.localParticipant.name || room.localParticipant.identity));
	}
	return command(room, { t: "add", text });
}

/**
 * Watching together, in the media panel: a link to paste, and what is playing
 * and coming up.
 *
 * Pasting starts the show here when nobody runs one and this person may
 * resolve links -- they are signed in, on a deployment that has a watch
 * gateway -- and otherwise hands the link to whoever runs it. The video itself
 * plays on the stage; see WatchScreen.
 */
export function WatchTab({ room, ready }: { room: Room; ready: boolean }) {
	const t = useT();
	const seen = useSyncExternalStore(subscribeShow, () => seenShow(room));
	const show = seen?.show;
	const mine = show !== undefined && show.holder === room.localParticipant.identity;
	const [pasted, setPasted] = useState("");
	const [busy, setBusy] = useState(false);

	if (room.options.e2ee !== undefined) {
		return <p className="px-4 py-8 text-center text-fg-muted text-xs">{t("Not available in an encrypted call")}</p>;
	}

	const canAdd = show !== undefined || ready;

	const add = async (event: FormEvent) => {
		event.preventDefault();
		const text = pasted.trim();
		if (!text || busy) return;
		setBusy(true);
		try {
			if (await addVideo(room, text, ready, t)) setPasted("");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<form onSubmit={(event) => void add(event)} className="flex gap-1.5 border-border border-b p-2">
				<input
					value={pasted}
					onChange={(event) => setPasted(event.target.value)}
					placeholder={t("A video link, or the text it was shared in")}
					aria-label={t("Video link")}
					maxLength={2000}
					disabled={!canAdd}
					className={cn(
						"h-8 min-w-0 flex-1 rounded-md border border-border bg-surface-hi px-2.5 text-[13px] text-fg",
						"outline-none transition-[border-color,box-shadow] placeholder:text-fg-muted disabled:opacity-50",
						"focus-visible:border-fg/40 focus-visible:ring-2 focus-visible:ring-fg/25",
					)}
				/>
				<Button type="submit" variant="secondary" size="icon" className="size-8" aria-label={t("Add a video")} disabled={!canAdd}>
					{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
				</Button>
			</form>

			<div className="flex flex-1 flex-col overflow-y-auto p-1.5">
				{show?.now ? (
					<>
						<VideoRow video={show.now} playing />
						{show.queue.map((video) => (
							<VideoRow
								key={video.key}
								video={video}
								onRemove={() => command(room, { t: "remove", key: video.key })}
							/>
						))}
					</>
				) : (
					<div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-fg-muted">
						<Clapperboard className="size-6" />
						<p className="text-xs">
							{canAdd
								? t("Paste a link and everybody watches it together, in step.")
								: t("When somebody signed in starts a video, it shows up here.")}
						</p>
					</div>
				)}
			</div>

			{mine && (
				<div className="flex justify-end border-border border-t p-2">
					<Button variant="ghost" size="sm" className="h-7 text-[12px]" onClick={() => closeTheatre(room)}>
						{t("Stop watching together")}
					</Button>
				</div>
			)}
		</div>
	);
}

function VideoRow({
	video,
	playing,
	onRemove,
}: {
	video: Video;
	playing?: boolean;
	onRemove?: () => void;
}) {
	const t = useT();
	// The title and picture come from the server by the ticket, never from the
	// call: see Video in live/watch.ts.
	const info = useVideoInfo(video.ticket);
	const known = typeof info === "object" ? info : undefined;
	return (
		<div className={cn("flex items-center gap-2.5 rounded-md px-2 py-1.5", playing && "bg-surface-hi/60")}>
			{known?.cover ? (
				<img src={known.cover} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-9 w-16 shrink-0 rounded object-cover" />
			) : (
				<span className="h-9 w-16 shrink-0 rounded bg-surface-hi" />
			)}
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-[12.5px]">{known?.title ?? (info === "failed" ? t("The video could not be read. Try again.") : "…")}</span>
				<span className="truncate text-[10.5px] text-fg-muted">
					{[playing ? t("Playing") : undefined, t("Added by {name}", { name: video.by }), video.duration ? clock(video.duration) : undefined]
						.filter(Boolean)
						.join(" · ")}
				</span>
			</span>
			{onRemove && (
				<Button
					variant="ghost"
					size="icon"
					className="size-6"
					aria-label={t("Take {title} off", { title: known?.title ?? "" })}
					onClick={onRemove}
				>
					<X className="size-3" />
				</Button>
			)}
		</div>
	);
}
