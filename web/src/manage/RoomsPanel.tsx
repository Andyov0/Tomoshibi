import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCallback, useState } from "react";
import { type Participant, type Track, api } from "./api";
import { usePoll } from "./poll";
import { Card, Empty, Failed } from "./Shell";
import { bitrate, day, since } from "./units";

/**
 * The rooms, and whoever is in the one selected.
 *
 * The right-hand side is the panel that earns this whole surface. What the
 * media server negotiated with each publisher — the codec, the resolution it
 * settled on, the layers underneath it and what each is allowed to spend — was
 * known here all along and visible nowhere. Working out whether a shared screen
 * was actually being sent at full resolution previously meant reading the
 * client's source and reasoning about it.
 */
export function RoomsPanel({
	canModerate,
	onSignedOut,
}: {
	canModerate: boolean;
	onSignedOut: () => void;
}) {
	const [selected, setSelected] = useState<string>();
	const [acting, setActing] = useState(false);
	const [failure, setFailure] = useState<string>();

	const { value, error, refresh } = usePoll(api.rooms, { onSignedOut });

	const live = value?.live ?? [];
	const known = value?.known ?? [];

	// Whatever was selected may have ended while it was being watched.
	const open = live.some((one) => one.name === selected) ? selected : undefined;

	const act = useCallback(
		async (what: () => Promise<void>) => {
			setActing(true);
			setFailure(undefined);

			try {
				await what();
				await refresh();
			} catch (err) {
				setFailure(err instanceof Error ? err.message : String(err));
			} finally {
				setActing(false);
			}
		},
		[refresh],
	);

	return (
		<div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[20rem_1fr]">
			<div className="flex flex-col gap-4">
				<Card title="In progress" note={`${live.length}`}>
					{error && <Failed>{error}</Failed>}

					{live.length === 0 ? (
						<Empty>Nothing is happening.</Empty>
					) : (
						<ul>
							{live.map((one) => (
								<li key={one.sid}>
									<button
										type="button"
										onClick={() => setSelected(one.name)}
										className={cn(
											"flex w-full items-baseline gap-2 border-border border-b px-4 py-2.5 text-left last:border-0",
											"transition-colors hover:bg-surface-hi",
											one.name === open && "bg-surface-hi",
										)}
									>
										<span className="truncate text-[13px]">{one.name}</span>
										<span className="ml-auto shrink-0 text-fg-muted text-xs tabular-nums">
											{one.participants} · {since(one.createdAt)}
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</Card>

				<Card title="Known" note="Every room this server has seen named">
					{known.length === 0 ? (
						<Empty>None recorded.</Empty>
					) : (
						<ul className="max-h-80 overflow-y-auto">
							{known.map((one) => (
								<li
									key={one.name}
									className="flex items-baseline gap-2 border-border border-b px-4 py-2 last:border-0"
								>
									<span className="truncate text-[13px]">{one.name}</span>
									<span className="ml-auto shrink-0 text-fg-muted text-xs">
										{day(one.lastSeen)}
									</span>
								</li>
							))}
						</ul>
					)}
				</Card>
			</div>

			{open ? (
				<People
					room={open}
					canModerate={canModerate}
					acting={acting}
					failure={failure}
					onSignedOut={onSignedOut}
					onClose={() => act(() => api.closeRoom(open))}
					onRemove={(identity) => act(() => api.remove(open, identity))}
					onMute={(identity, track) => act(() => api.mute(open, identity, track))}
				/>
			) : (
				<Card title="Participants">
					<Empty>Choose a room.</Empty>
				</Card>
			)}
		</div>
	);
}

function People({
	room,
	canModerate,
	acting,
	failure,
	onSignedOut,
	onClose,
	onRemove,
	onMute,
}: {
	room: string;
	canModerate: boolean;
	acting: boolean;
	failure?: string;
	onSignedOut: () => void;
	onClose: () => void;
	onRemove: (identity: string) => void;
	onMute: (identity: string, track: string) => void;
}) {
	const ask = useCallback(() => api.participants(room), [room]);
	const { value, error } = usePoll(ask, { onSignedOut });

	const people = value ?? [];

	return (
		<Card
			title={room}
			note={`${people.length} ${people.length === 1 ? "person" : "people"}`}
			className="self-start"
		>
			{error && <Failed>{error}</Failed>}
			{failure && <Failed>{failure}</Failed>}

			{canModerate && (
				<div className="flex justify-end border-border border-b px-4 py-2">
					<Button variant="danger" size="sm" disabled={acting} onClick={onClose}>
						Close this room
					</Button>
				</div>
			)}

			{people.length === 0 ? (
				<Empty>Nobody is here.</Empty>
			) : (
				<ul>
					{people.map((one) => (
						<Person
							key={one.sid}
							person={one}
							canModerate={canModerate}
							acting={acting}
							onRemove={() => onRemove(one.identity)}
							onMute={(track) => onMute(one.identity, track)}
						/>
					))}
				</ul>
			)}
		</Card>
	);
}

function Person({
	person,
	canModerate,
	acting,
	onRemove,
	onMute,
}: {
	person: Participant;
	canModerate: boolean;
	acting: boolean;
	onRemove: () => void;
	onMute: (track: string) => void;
}) {
	return (
		<li className="border-border border-b px-4 py-3 last:border-0">
			<div className="flex items-baseline gap-2">
				<span className="font-medium text-[13px]">{person.name || person.identity}</span>

				{/* The mark, and which kind. An earned one is the same person as
				    last time; an issued one is only a way to tell two people
				    with one name apart for the length of a call. */}
				<span
					className={cn("readout text-[11px]", person.trip.proven ? "text-fg-muted" : "text-fg-muted/50")}
					title={
						person.trip.proven
							? "Earned from a passphrase"
							: "Issued for this call, and says nothing about who they are"
					}
				>
					{person.trip.proven ? "·" : ""}
					{person.trip.mark}
				</span>

				<span className="ml-auto text-fg-muted text-xs tabular-nums">
					{since(person.joinedAt)}
				</span>

				{canModerate && (
					<Button variant="ghost" size="sm" disabled={acting} onClick={onRemove}>
						Remove
					</Button>
				)}
			</div>

			{person.tracks.length > 0 && (
				<ul className="mt-2 flex flex-col gap-1.5">
					{person.tracks.map((track) => (
						<TrackRow
							key={track.sid}
							track={track}
							canModerate={canModerate}
							acting={acting}
							onMute={() => onMute(track.sid)}
						/>
					))}
				</ul>
			)}
		</li>
	);
}

/**
 * One published track, with what it actually settled on.
 *
 * The layers are the point. A publisher asking for 1080p and a subscriber being
 * sent 540p look identical from every other angle, and the difference is the
 * whole of why a shared screen can look soft while every setting says otherwise.
 */
function TrackRow({
	track,
	canModerate,
	acting,
	onMute,
}: {
	track: Track;
	canModerate: boolean;
	acting: boolean;
	onMute: () => void;
}) {
	const codec = track.mime.replace(/^(video|audio)\//i, "").toLowerCase();

	return (
		<li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md bg-surface-hi/50 px-2.5 py-1.5 text-xs">
			<span className="w-24 shrink-0 text-fg-muted">{source(track.source)}</span>

			<span className="readout text-[11px]">{codec || "—"}</span>

			{track.width > 0 && (
				<span className="readout text-[11px] tabular-nums">
					{track.width}×{track.height}
				</span>
			)}

			{track.muted && <span className="text-fg-muted">muted</span>}

			{track.layers.length > 0 && (
				<span className="readout text-[11px] text-fg-muted tabular-nums">
					{track.layers
						.map((layer) => `${layer.height}p ${bitrate(layer.bitrate)}`)
						.join("  ·  ")}
				</span>
			)}

			{canModerate && !track.muted && (
				<Button
					variant="ghost"
					size="sm"
					disabled={acting}
					onClick={onMute}
					className="ml-auto h-6 px-2 text-[11px]"
				>
					Mute
				</Button>
			)}
		</li>
	);
}

/** The server's own names for these are shouted; these are the ones people use. */
function source(name: string): string {
	switch (name) {
		case "CAMERA":
			return "camera";
		case "MICROPHONE":
			return "microphone";
		case "SCREEN_SHARE":
			return "screen";
		case "SCREEN_SHARE_AUDIO":
			return "screen audio";
		default:
			return name.toLowerCase().replace(/_/g, " ");
	}
}
