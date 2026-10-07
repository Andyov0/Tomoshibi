import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { keep, recall } from "@/lib/storage";
import {
	type Library,
	type LibraryTrack,
	type Quality,
	audioUrl,
	clock,
	describeAudio,
	describeTrack,
	searchLibrary,
} from "@/live/music";
import { actionFailed, losslessGaveUp } from "@/live/notices";
import { nowPlaying, playLibraryTrack, rememberedLossless, stopListening, subscribePlaying } from "@/live/sound";
import type { Room } from "livekit-client";
import { CircleStop, Loader2, Search, X } from "lucide-react";
import { type FormEvent, useState, useSyncExternalStore } from "react";

/**
 * Playing a track from the music library into the call.
 *
 * In the same frame as the other panels -- a sheet up the bottom edge while
 * narrow, a card in the corner once there is room -- and opened from the share
 * menu, beside sharing an application's sound, because it is the same act from
 * a different source: what everybody hears is published exactly as a shared
 * application's sound is, losslessly where the track is lossless.
 *
 * What is playing is shown with what it actually is, read off the file --
 * "FLAC · 24-bit · 44.1 kHz" -- rather than with what was asked for: a library
 * that is not signed in quietly plays 320 kbit/s, and somebody who asked for
 * the best should be able to see when that is what they got.
 */
const QUALITY_KEY = "meet-live.music-quality";

/**
 * Lossless by default, and the highest tier only when asked for.
 *
 * The highest is a master where there is one -- 24-bit at 192 kHz on one of the
 * libraries this was built against -- which is two hundred megabytes to fetch,
 * four hundred to hold decoded, and several megabits a second to every
 * listener. A 24-bit file at the CD's rate is lossless and a tenth of that.
 */
function rememberedQuality(): Quality {
	return recall(QUALITY_KEY) === "best" ? "best" : "lossless";
}

export function MusicPanel({
	room,
	libraries,
	leaving = false,
	onClose,
}: {
	room: Room;
	libraries: Library[];
	/** Playing its way out, for the exit animation. */
	leaving?: boolean;
	onClose: () => void;
}) {
	const t = useT();
	const [source, setSource] = useState(() => (libraries.find((one) => one.signedIn) ?? libraries[0])?.id ?? "");
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<LibraryTrack[]>();
	const [searching, setSearching] = useState(false);
	const [starting, setStarting] = useState<string>();
	const [progress, setProgress] = useState(0);
	const [problem, setProblem] = useState<string>();
	const [quality, setQuality] = useState<Quality>(rememberedQuality);

	const now = useSyncExternalStore(subscribePlaying, () => nowPlaying(room));
	const library = libraries.find((one) => one.id === source);

	const search = async (event?: FormEvent) => {
		event?.preventDefault();
		const asked = query.trim();
		if (!asked || searching) return;

		setSearching(true);
		setProblem(undefined);
		try {
			setResults(await searchLibrary(source, asked));
		} catch {
			setProblem(t("The library did not answer. Try again."));
		} finally {
			setSearching(false);
		}
	};

	const play = async (track: LibraryTrack) => {
		if (starting) return;
		setStarting(track.id);
		setProgress(0);
		setProblem(undefined);

		try {
			const audio = await describeTrack(source, track.id, quality);
			if (audio === "unavailable") {
				setProblem(t("This song is not available to the library's account."));
				return;
			}

			await playLibraryTrack(
				room,
				{
					url: audioUrl(source, track.id, quality),
					rate: audio.rate,
					format: audio.format,
					bits: audio.bits,
					now: { title: track.title, artists: track.artists.join(" / "), quality: describeAudio(audio) },
				},
				rememberedLossless(),
				losslessGaveUp,
				setProgress,
			);
		} catch {
			actionFailed(t("That song could not be played."));
		} finally {
			setStarting(undefined);
		}
	};

	return (
		<aside
			className={cn(
				"absolute z-20 flex flex-col overflow-hidden border border-border",
				"bg-surface/95 shadow-2xl backdrop-blur-md",
				leaving ? "animate-depart" : "animate-arrive",
				"inset-x-0 bottom-0 h-[70%] rounded-t-2xl",
				"pb-[calc(env(safe-area-inset-bottom)+3.5rem)] sm:pb-0",
				"sm:inset-x-auto sm:right-3 sm:bottom-3 sm:h-[min(32rem,calc(100%-5.5rem))] sm:w-80 sm:rounded-xl",
			)}
		>
			<header className="flex items-center justify-between border-border border-b px-3 py-2">
				<strong className="font-semibold text-[12.5px]">{t("Play music")}</strong>
				<Button variant="ghost" size="icon" className="size-6" aria-label={t("Close music")} onClick={onClose}>
					<X className="size-3.5" />
				</Button>
			</header>

			<div className="flex flex-col gap-2 border-border border-b p-2">
				{libraries.length > 1 && (
					<div role="tablist" className="flex gap-1">
						{libraries.map((one) => (
							<button
								key={one.id}
								type="button"
								role="tab"
								aria-selected={one.id === source}
								onClick={() => {
									setSource(one.id);
									setResults(undefined);
									setProblem(undefined);
								}}
								className={cn(
									"flex-1 rounded-md border px-2 py-1 text-[12px] transition-colors",
									one.id === source
										? "border-tally/50 bg-tally/15 text-fg"
										: "border-border text-fg-muted hover:bg-surface-hi hover:text-fg",
								)}
							>
								{one.name}
							</button>
						))}
					</div>
				)}

				{library && !library.signedIn && (
					<p className="text-[11.5px] text-fg-muted">{t("Not signed in, so at most 320 kbps.")}</p>
				)}

				<div className="flex items-center gap-1.5">
					<span className="text-[11.5px] text-fg-muted">{t("Quality")}</span>
					{(["lossless", "best"] as const).map((option) => (
						<button
							key={option}
							type="button"
							aria-pressed={quality === option}
							onClick={() => {
								setQuality(option);
								keep(QUALITY_KEY, option === "best" ? "best" : undefined);
							}}
							className={cn(
								"rounded-md border px-2 py-0.5 text-[11.5px] transition-colors",
								quality === option
									? "border-tally/50 bg-tally/15 text-fg"
									: "border-border text-fg-muted hover:bg-surface-hi hover:text-fg",
							)}
						>
							{t(option === "best" ? "Highest" : "Lossless")}
						</button>
					))}
				</div>
				{quality === "best" && (
					<p className="text-[11px] text-fg-muted">{t("Hi-Res and masters are large, and take longer to start.")}</p>
				)}

				<form onSubmit={search} className="flex gap-1.5">
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t("Search songs")}
						aria-label={t("Search songs")}
						maxLength={100}
						className={cn(
							"h-8 min-w-0 flex-1 rounded-md border border-border bg-surface-hi px-2.5 text-[13px] text-fg",
							"outline-none transition-[border-color,box-shadow] placeholder:text-fg-muted",
							"focus-visible:border-fg/40 focus-visible:ring-2 focus-visible:ring-fg/25",
						)}
					/>
					<Button type="submit" variant="secondary" size="icon" className="size-8" aria-label={t("Search")}>
						{searching ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
					</Button>
				</form>
			</div>

			<div className="flex flex-1 flex-col overflow-y-auto p-1.5">
				{problem && <p className="px-2 py-2 text-[12px] text-danger">{problem}</p>}

				{results === undefined ? (
					<p className="px-3 py-8 text-center text-fg-muted text-xs">{t("Search for a song to play into the call.")}</p>
				) : results.length === 0 ? (
					<p className="px-3 py-8 text-center text-fg-muted text-xs">{t("Nothing found.")}</p>
				) : (
					results.map((track) => (
						<button
							key={track.id}
							type="button"
							onClick={() => void play(track)}
							disabled={starting !== undefined}
							className={cn(
								"flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
								"hover:bg-surface-hi disabled:opacity-60",
							)}
						>
							{track.cover ? (
								<img src={track.cover} alt="" loading="lazy" className="size-9 shrink-0 rounded object-cover" />
							) : (
								<span className="size-9 shrink-0 rounded bg-surface-hi" />
							)}
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="truncate text-[13px] text-fg">{track.title}</span>
								<span className="truncate text-[11.5px] text-fg-muted">
									{[track.artists.join(" / "), track.album].filter(Boolean).join(" · ")}
								</span>
							</span>
							{starting === track.id ? (
								<span className="flex shrink-0 items-center gap-1 text-[11px] text-fg-muted tabular-nums">
									<Loader2 className="size-3.5 animate-spin" />
									{progress > 0 ? `${Math.round(progress * 100)}%` : ""}
								</span>
							) : (
								<span className="shrink-0 text-[11px] text-fg-muted tabular-nums">{clock(track.duration)}</span>
							)}
						</button>
					))
				)}
			</div>

			{now && (
				<div className="flex animate-arrive items-center gap-2 border-border border-t px-3 py-2">
					<span className="flex min-w-0 flex-1 flex-col">
						<span className="truncate text-[12.5px] text-fg">{now.title}</span>
						<span className="truncate text-[11px] text-fg-muted">
							{[now.artists, now.quality].filter(Boolean).join(" · ")}
						</span>
					</span>
					<Button
						variant="ghost"
						size="icon"
						className="size-7"
						aria-label={t("Stop the music")}
						onClick={() => void stopListening(room)}
					>
						<CircleStop className="size-4" />
					</Button>
				</div>
			)}
		</aside>
	);
}
