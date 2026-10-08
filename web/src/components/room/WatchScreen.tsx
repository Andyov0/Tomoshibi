import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/useT";
import { useVideoInfo } from "@/hooks/useVideoInfo";
import { keep, recall } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { clock } from "@/live/music";
import {
	CLOSE_ENOUGH,
	type Seen,
	type Video,
	command,
	correction,
	expected,
	myTheatre,
	seenShow,
	subscribeShow,
} from "@/live/watch";
import type { Resolved } from "@/live/watch-api";
import { BUFFERING, ENDED, PLAYING, type YouTubePlayer, youtubeApi } from "@/live/youtube";
import type { Room } from "livekit-client";
import { Clapperboard, ListVideo, Loader2, Pause, Play, SkipForward, Volume2, VolumeX } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * The video everybody is watching, as this browser plays it.
 *
 * Each viewer plays the video themselves and keeps to the show's timeline; see
 * live/watch.ts. Where it plays from is decided here, by trying: the place the
 * video is, and if that fails -- an error, or a player that has still not
 * begun STALL_MS after it should have -- the same video relayed by the
 * deployment. YouTube is the one source whose addresses nobody else can use,
 * so it plays through YouTube's own player where YouTube can be reached and
 * through the relay otherwise.
 *
 * The controls drive the show, not this player: pressing pause asks the show
 * to pause, and everybody pauses. This player also does it at once, so the
 * press is felt without waiting for the show's answer to come back.
 */

/**
 * A player that has not begun to play this long after it should have is given
 * the relay. The same as the show's own wait for its holder (STARTING_MS): a
 * longer one was measured as twelve seconds of a spinner for a viewer whose
 * connection to the video's own servers was slow.
 */
export const STALL_MS = 8000;

/**
 * At most one jump in this long. A jump over the internet takes a while to land,
 * and YouTube's player goes on reporting where it was until it has: held to the
 * show every quarter second, it was asked to jump again and again.
 */
const SEEK_GAP_MS = 1500;

/** How long YouTube's player is given to begin after being asked, before the browser is taken to have refused. */
const YOUTUBE_REFUSED_MS = 1500;

/** How often the player is held to the show. */
const KEEP_MS = 250;

const VOLUME_KEY = "meet-live.watch-volume";

export function rememberedVolume(): number {
	// Nothing kept is null, which Number makes nought: see monitorVolume.
	const raw = recall(VOLUME_KEY);
	const kept = Number(raw);
	return raw != null && raw !== "" && Number.isFinite(kept) && kept >= 0 && kept <= 1 ? kept : 1;
}

/** One way of playing: a video element, or YouTube's player. */
interface Handle {
	time(): number;
	playing(): boolean;
	ready(): boolean;
	play(): Promise<void>;
	pause(): void;
	seek(to: number): void;
	rate(rate: number): void;
	currentRate(): number;
	volume(level: number): void;
	mute(on: boolean): void;
	/** Whether this one can run a little fast or slow; YouTube's cannot by small amounts. */
	nudges: boolean;
	youtube: boolean;
}

export function WatchScreen({ room, onStage, onOpenPanel }: { room: Room; onStage: boolean; onOpenPanel: () => void }) {
	const t = useT();
	const seen = useSyncExternalStore(subscribeShow, () => seenShow(room));
	const video = seen?.show.now;
	const info = useVideoInfo(video?.ticket);

	// On the stage, a press on the video is for the video: it does not take it
	// off the stage, as a press on a picture does. Off it, the tile is a card,
	// and a press anywhere brings it up.
	const contain = (event: { stopPropagation(): void }) => {
		if (onStage) event.stopPropagation();
	};

	if (!seen || !video) {
		return (
			<div className="absolute inset-0 grid place-items-center bg-black" onClick={contain}>
				<div className="flex flex-col items-center gap-3 px-4 text-center text-fg-muted">
					<Clapperboard className="size-8" />
					<p className="text-sm">{t("Nothing is playing. Paste a video link to watch together.")}</p>
					<Button
						variant="secondary"
						size="sm"
						onClick={(event) => {
							event.stopPropagation();
							onOpenPanel();
						}}
					>
						{t("Add a video")}
					</Button>
				</div>
			</div>
		);
	}

	if (info === undefined || info === "failed") {
		return (
			<div className="absolute inset-0 grid place-items-center bg-black text-white/70" onClick={contain}>
				{info === "failed" ? (
					<div className="flex flex-col items-center gap-3 px-4 text-center">
						<p className="text-sm">{t("The video could not be read. Try again.")}</p>
						<Button
							variant="secondary"
							size="sm"
							onClick={(event) => {
								event.stopPropagation();
								command(room, { t: "skip", key: video.key });
							}}
						>
							{t("Next video")}
						</Button>
					</div>
				) : (
					<Loader2 className="size-6 animate-spin" />
				)}
			</div>
		);
	}

	// Keyed by the video, so the next one starts from a player of its own.
	return (
		<div className="absolute inset-0" onClick={contain}>
			<Player key={video.key} room={room} video={video} info={info} seen={seen} onOpenPanel={onOpenPanel} />
		</div>
	);
}

function Player({
	room,
	video,
	info,
	seen,
	onOpenPanel,
}: {
	room: Room;
	video: Video;
	info: Resolved;
	seen: Seen;
	onOpenPanel: () => void;
}) {
	const t = useT();
	const [relayed, setRelayed] = useState(info.relay);
	const [blocked, setBlocked] = useState(false);
	/** For a video that starts on the relay: whether the copy from where it is has been tried. */
	const triedDirect = useRef(false);
	const [volume, setVolumeState] = useState(rememberedVolume);
	const [muted, setMuted] = useState(false);
	const [now, setNow] = useState(0);
	const [scrubbing, setScrubbing] = useState<number>();
	const [waiting, setWaiting] = useState(true);

	const handle = useRef<Handle | undefined>(undefined);
	const latest = useRef(seen);
	latest.current = seen;
	/** Once this player has played at all, a later stall is buffering, not a source that does not work. */
	const played = useRef(false);

	const videoElement = useRef<HTMLVideoElement>(null);
	const youtubeHost = useRef<HTMLDivElement>(null);

	const playsAsYoutube = info.play.kind === "youtube" && !relayed;
	// The relay, unless this is playing from where the video is: a relay-only
	// source has nowhere else to play from.
	const source =
		relayed || info.play.kind === "youtube" || info.play.kind === "relay"
			? info.proxy
			: (info.play as { kind: "file" | "hls"; url: string });

	// A video element, for a file or an HLS playlist, from where it is or relayed.
	useEffect(() => {
		if (playsAsYoutube) return;
		const element = videoElement.current;
		if (!element) return;

		let stopped = false;
		let destroy = () => {};
		// Given the relay once, and only while it has never played: a stall
		// after that is buffering, which the relay would not cure. Measured
		// before: any seek more than twelve seconds in moved a working direct
		// source onto the relay for good.
		const failed = (why: string) => {
			if (stopped || played.current) return;
			if (!relayed) {
				console.warn("watch: playing from where the video is failed, relaying", why, element.error?.code);
				setRelayed(true);
			} else if (info.relay && info.play.kind !== "relay" && !triedDirect.current) {
				// The relay was the first choice and failed: the lower quality
				// from where the video is, rather than nothing.
				console.warn("watch: the relay failed, playing from where the video is", why, element.error?.code);
				triedDirect.current = true;
				setRelayed(false);
			}
		};
		const errored = () => failed("error");
		const began = () => {
			played.current = true;
		};
		const playable = () => myTheatre(room)?.ready(video.key);
		// Here, with the element it belongs to: a holder whose YouTube fell
		// back to the relay has an element only from then on, and an ending
		// it never heard left the whole room at the last frame.
		const ended = () => myTheatre(room)?.ended(video.key);

		element.addEventListener("error", errored);
		element.addEventListener("playing", began);
		element.addEventListener("canplay", playable);
		element.addEventListener("ended", ended);

		if (source.kind === "hls") {
			// hls.js wherever it can run, and the browser's own HLS only where it
			// cannot, which is iOS. Not the other way round: Chrome now says it
			// can play HLS itself, and given YouTube's playlist -- the picture
			// and the sound as separate renditions -- it sat at the first frame
			// with no error at all.
			void import("hls.js").then(({ default: Hls }) => {
				if (stopped) return;
				if (!Hls.isSupported()) {
					if (element.canPlayType("application/vnd.apple.mpegurl")) element.src = source.url;
					else failed("no HLS");
					return;
				}
				// Held to the size it is shown at, for a relay this page fell back
				// to: a film at four times the pixels the tile has is the
				// deployment's bandwidth spent on nothing anybody sees. Not for
				// one that starts on the relay because its better qualities come
				// no other way: there the deployment chose the quality, and the
				// connection alone decides how much of it -- 4K where it is.
				const hls = new Hls({ capLevelToPlayerSize: !info.relay, maxBufferLength: 30 });
				hls.on(Hls.Events.ERROR, (_event, data) => {
					// Said, without the address: what failed and how is what
					// anybody looking into a video that would not play needs.
					if (data.fatal) {
						console.warn("watch: the playlist failed", data.type, data.details, data.response?.code);
						failed("playlist");
					}
				});
				hls.loadSource(source.url);
				hls.attachMedia(element);
				destroy = () => hls.destroy();
			});
		} else {
			element.src = source.url;
		}

		handle.current = {
			nudges: true,
			youtube: false,
			time: () => element.currentTime,
			playing: () => !element.paused && !element.ended,
			ready: () => element.readyState >= 1,
			play: () => element.play(),
			pause: () => element.pause(),
			seek: (to) => {
				element.currentTime = to;
			},
			rate: (rate) => {
				if (element.playbackRate !== rate) element.playbackRate = rate;
			},
			currentRate: () => element.playbackRate,
			volume: (level) => {
				element.volume = level;
			},
			// muted rather than volume: on iOS a video's volume is the
			// hardware's and cannot be set from a page at all.
			mute: (on) => {
				element.muted = on;
			},
		};

		const started = Date.now();
		const stall = setInterval(() => {
			if (stopped || played.current || (relayed && !info.relay) || (relayed && triedDirect.current)) return;
			if (latest.current.show.playing && element.readyState < 3 && Date.now() - started > STALL_MS) failed("stalled");
		}, 1000);

		return () => {
			stopped = true;
			clearInterval(stall);
			element.removeEventListener("error", errored);
			element.removeEventListener("playing", began);
			element.removeEventListener("canplay", playable);
			element.removeEventListener("ended", ended);
			destroy();
			element.removeAttribute("src");
			element.load();
			handle.current = undefined;
		};
	}, [playsAsYoutube, source.kind, source.url, relayed, room, video.key, info.relay]);

	// YouTube's own player, where YouTube can be reached; the relay where it cannot.
	useEffect(() => {
		if (!playsAsYoutube || !info.play.id) return;
		const host = youtubeHost.current;
		if (!host) return;

		let stopped = false;
		let player: YouTubePlayer | undefined;
		let isReady = false;
		const mount = document.createElement("div");
		host.append(mount);
		const started = Date.now();

		youtubeApi().then(
			(api) => {
				if (stopped) return;
				player = new api.Player(mount, {
					videoId: info.play.id as string,
					width: "100%",
					height: "100%",
					playerVars: { controls: 0, disablekb: 1, playsinline: 1, rel: 0, modestbranding: 1, iv_load_policy: 3 },
					events: {
						onReady: () => {
							isReady = true;
							handle.current = {
								nudges: false,
								youtube: true,
								time: () => player?.getCurrentTime() ?? 0,
								playing: () => player?.getPlayerState() === PLAYING || player?.getPlayerState() === BUFFERING,
								ready: () => isReady,
								// Asked through a message to another origin, which answers
								// nothing either way: whether the browser let it play is
								// read off the player a moment later; see keep.
								play: async () => player?.playVideo(),
								pause: () => player?.pauseVideo(),
								seek: (to) => player?.seekTo(to, true),
								rate: () => {},
								currentRate: () => 1,
								volume: (level) => player?.setVolume(Math.round(level * 100)),
								mute: (on) => (on ? player?.mute() : player?.unMute()),
							};
							myTheatre(room)?.ready(video.key);
						},
						onStateChange: (event) => {
							if (event.data === PLAYING) {
								played.current = true;
								setBlocked(false);
							}
							if (event.data === ENDED) myTheatre(room)?.ended(video.key);
						},
						// Embedding refused, or the video unavailable here: the relay.
						onError: (event) => {
							console.warn("watch: YouTube's player refused the video", event.data);
							if (!stopped) setRelayed(true);
						},
					},
				});
			},
			() => {
				if (!stopped) setRelayed(true);
			},
		);

		// The API arrived but the player never became ready: the relay. A
		// player that is ready and refused a press is the browser's doing,
		// and is waited on; see blocked.
		const stall = setInterval(() => {
			if (stopped || played.current || !latest.current.show.playing) return;
			if (Date.now() - started > STALL_MS && !isReady) setRelayed(true);
		}, 1000);

		return () => {
			stopped = true;
			clearInterval(stall);
			player?.destroy();
			mount.remove();
			handle.current = undefined;
		};
	}, [playsAsYoutube, info.play.id, video.key, room]);

	// Held to the show, a few times a second.
	const asked = useRef(0);
	const jumped = useRef(0);
	useEffect(() => {
		const jump = (player: Handle, to: number) => {
			if (Date.now() - jumped.current < SEEK_GAP_MS) return;
			jumped.current = Date.now();
			player.seek(to);
		};

		const keep = () => {
			const player = handle.current;
			const show = latest.current;
			if (!player?.ready()) {
				setWaiting(true);
				return;
			}
			setWaiting(false);

			const want = expected(show);
			const playing = show.show.playing;
			if (playing && !player.playing()) {
				// Started from where the show is, rather than from where this
				// player stood and then chased: measured, starting on the next
				// tick put every player about 0.4 s behind and five per cent fast
				// for the next eight seconds.
				if (!video.live && Math.abs(player.time() - want) > CLOSE_ENOUGH) jump(player, want);
				if (!asked.current) asked.current = Date.now();
				player.play().then(
					() => {
						if (!player.youtube) setBlocked(false);
					},
					// Refused by the browser for want of a press: one press will
					// do. Only that refusal: a source that will not play is not
					// cured by a press, and asking for one sent somebody pressing
					// at a video that could never start.
					(err: unknown) => {
						if (err instanceof DOMException && err.name === "NotAllowedError") setBlocked(true);
					},
				);
				// YouTube's answer is its state, not the promise: asked and still
				// not playing a moment later is refused. iOS refuses every play
				// not started by a press inside YouTube's own frame.
				if (player.youtube && Date.now() - asked.current > YOUTUBE_REFUSED_MS) setBlocked(true);
			} else if (!playing && player.playing()) {
				player.pause();
			}
			if (player.playing() || !playing) asked.current = 0;

			// Something live has no moment to agree on; only playing or not.
			if (!video.live) {
				const fix = correction(player.time(), want, playing, player.currentRate());
				if (fix.seek !== undefined) jump(player, fix.seek);
				else if (!player.nudges && playing && Math.abs(player.time() - want) > 1) jump(player, want);
				if (player.nudges) player.rate(fix.rate);
			}

			setNow(player.time());
		};

		const timer = setInterval(keep, KEEP_MS);
		keep();
		return () => clearInterval(timer);
	}, [video.live]);

	// Volume, this viewer's own.
	useEffect(() => {
		handle.current?.volume(volume);
		handle.current?.mute(muted);
	});

	const playing = seen.show.playing;
	const shown = scrubbing ?? now;
	const length = video.duration || info.duration;

	const toggle = () => {
		// At once here, so the press is felt; the show's answer brings everybody else.
		if (playing) handle.current?.pause();
		else
			void handle.current?.play().catch((err: unknown) => {
				if (err instanceof DOMException && err.name === "NotAllowedError") setBlocked(true);
			});
		command(room, { t: playing ? "pause" : "play" });
	};

	const seekTo = (to: number) => {
		jumped.current = Date.now();
		handle.current?.seek(to);
		command(room, { t: "seek", to });
		setScrubbing(undefined);
	};

	// A refused YouTube player is started by a press on the player itself: one
	// on anything of this page's is not a press inside YouTube's frame, and iOS
	// lets only that start it. So the frame takes presses while it is refused.
	const tapYoutube = blocked && playsAsYoutube;

	return (
		<div className="group absolute inset-0 bg-black">
			{playsAsYoutube ? (
				// The iframe otherwise takes no presses: the controls below drive
				// the show, and YouTube's own would drive only this one player.
				<div
					ref={youtubeHost}
					className={cn("absolute inset-0 [&_iframe]:size-full", !tapYoutube && "[&_iframe]:pointer-events-none")}
				/>
			) : (
				<video ref={videoElement} playsInline className="absolute inset-0 size-full object-contain" />
			)}

			{waiting && (
				<div className="pointer-events-none absolute inset-0 grid place-items-center">
					<Loader2 className="size-6 animate-spin text-white/70" />
				</div>
			)}

			{blocked &&
				(tapYoutube ? (
					<div className="pointer-events-none absolute inset-x-0 top-3 grid place-items-center">
						<span className="flex items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-sm text-white">
							<Play className="size-4" />
							{t("Tap the video to join")}
						</span>
					</div>
				) : (
					<button
						type="button"
						onClick={(event) => {
							event.stopPropagation();
							void handle.current?.play().then(() => setBlocked(false));
						}}
						className="absolute inset-0 grid place-items-center bg-black/50 text-sm text-white"
					>
						<span className="flex items-center gap-2 rounded-full bg-white/15 px-4 py-2">
							<Play className="size-4" />
							{t("Press to join the video")}
						</span>
					</button>
				))}

			<div
				className={cn(
					"absolute inset-x-0 bottom-0 flex flex-col gap-1.5 bg-gradient-to-t from-black/80 to-transparent px-3 pt-8 pb-2",
					"opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100",
					!playing && "opacity-100",
				)}
				// Presses and keys here are the controls', not the tile's: the
				// tile takes Enter and Space for itself, and a control that cannot
				// be worked from the keyboard is one some people cannot work.
				onClick={(event) => event.stopPropagation()}
				onDoubleClick={(event) => event.stopPropagation()}
				onKeyDown={(event) => event.stopPropagation()}
			>
				<div className="flex min-w-0 items-baseline gap-2 text-white">
					<span className="truncate font-medium text-[13px]">{info.title}</span>
					<span className="shrink-0 text-[11px] text-white/60">
						{[t("Added by {name}", { name: video.by }), relayed ? t("Relayed") : undefined].filter(Boolean).join(" · ")}
					</span>
				</div>

				{length > 0 && !video.live && (
					<input
						type="range"
						min={0}
						max={length}
						step={0.5}
						value={Math.min(shown, length)}
						aria-label={t("Position in the video")}
						onChange={(event) => setScrubbing(event.target.valueAsNumber)}
						onPointerUp={(event) => seekTo((event.target as HTMLInputElement).valueAsNumber)}
						onKeyUp={(event) => seekTo((event.target as HTMLInputElement).valueAsNumber)}
						className="w-full cursor-pointer accent-white"
					/>
				)}

				<div className="flex items-center gap-1 text-white">
					<Control label={playing ? t("Pause for everybody") : t("Play for everybody")} onClick={toggle}>
						{playing ? <Pause className="size-4" /> : <Play className="size-4" />}
					</Control>
					<Control label={t("Next video")} onClick={() => command(room, { t: "skip", key: video.key })}>
						<SkipForward className="size-4" />
					</Control>
					{/* The exact position as well, for whoever is checking two
					    players against each other: YouTube's frame cannot be read
					    from outside, and the clock shows whole seconds. */}
					<span className="px-1 text-[11px] text-white/80 tabular-nums" data-position={now.toFixed(2)}>
						{video.live ? t("Live") : length > 0 ? `${clock(shown)} / ${clock(length)}` : clock(shown)}
					</span>

					<span className="flex-1" />

					<Control label={muted ? t("Unmute the video") : t("Mute the video")} onClick={() => setMuted(!muted)}>
						{muted || volume === 0 ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
					</Control>
					<input
						type="range"
						min={0}
						max={1}
						step={0.05}
						value={muted ? 0 : volume}
						aria-label={t("Video volume")}
						onChange={(event) => {
							setMuted(false);
							setVolumeState(event.target.valueAsNumber);
							keep(VOLUME_KEY, event.target.valueAsNumber === 1 ? undefined : String(event.target.valueAsNumber));
						}}
						className="hidden w-20 cursor-pointer accent-white sm:block"
					/>
					<Control label={t("Videos")} onClick={onOpenPanel}>
						<ListVideo className="size-4" />
					</Control>
				</div>
			</div>
		</div>
	);
}

function Control({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			onClick={onClick}
			className="grid size-8 place-items-center rounded-full transition-colors hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white"
		>
			{children}
		</button>
	);
}
