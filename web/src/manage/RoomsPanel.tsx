import { Flagged } from "@/components/room/Flag";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useLingering } from "@/hooks/useLingering";
import {
	ArrowRight,
	ChevronLeft,
	Clock,
	DoorClosed,
	LogIn,
	MicOff,
	Move,
	Server,
	UserMinus,
} from "lucide-react";
import { useCallback, useState } from "react";
import { type Participant, type Relay, type Track, api } from "./api";
import { actionFailed } from "@/live/notices";
import { OpeningCard } from "./OpeningCard";
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

	// The machines a room can be moved to. Read once here rather than inside the
	// detail beside it, so opening a room does not fetch a list that has not
	// changed since the page was drawn.
	const { value: fleet } = usePoll(api.relays, { every: 30_000, onSignedOut });
	const relays = fleet?.relays ?? [];

	const { value, error, refresh } = usePoll(api.rooms, { onSignedOut });

	const live = value?.live ?? [];
	const known = value?.known ?? [];

	// Whatever was selected may have ended while it was being watched.
	const open = live.some((one) => one.name === selected) ? selected : undefined;

	const act = useCallback(
		async (what: () => Promise<void>) => {
			setActing(true);

			try {
				await what();
				await refresh();
			} catch (err) {
				// Something that happened rather than something still true: the
				// room is still there, the panel still works, and one press did
				// not take. It fades, like every other event in this deployment.
				actionFailed(err instanceof Error ? err.message : String(err));
			} finally {
				setActing(false);
			}
		},
		[refresh],
	);

	return (
		<div
			className={cn(
				"mx-auto grid max-w-6xl gap-3 sm:gap-4 lg:grid-cols-[20rem_1fr]",
				// A drill-down while narrow: the list, then the room, with a way
				// back. Stacked, the list would push the detail below the fold and
				// every tap would become a scroll back up.
				open && "max-lg:block",
			)}
		>
			<div className={cn("flex flex-col gap-3 sm:gap-4", open && "max-lg:hidden")}>
				<Card title="In progress" note={`${live.length}`}>
					{error && <Failed>{error}</Failed>}

					{live.length === 0 ? (
						<Empty>No calls right now.</Empty>
					) : (
						<ul>
							{live.map((one) => (
								<li key={one.sid}>
									<button
										type="button"
										onClick={() => setSelected(one.name)}
										className={cn(
											"flex w-full flex-col gap-0.5 border-border border-b px-4 py-2.5 text-left last:border-0",
											"transition-colors hover:bg-surface-hi",
											one.name === open && "bg-surface-hi",
										)}
									>
										<span className="flex w-full items-baseline gap-2">
											<span className="truncate text-[13px]">{one.name}</span>
											<span className="ml-auto shrink-0 text-fg-muted text-xs tabular-nums">
												{one.participants} · {since(one.createdAt)}
											</span>
										</span>

										{/* Which machine the meeting is actually on.
										    Not asked of the media server, which reports a
										    room from whichever node answered — every node
										    answers for the whole cluster, so that field
										    holds the machine that was asked rather than
										    the machine holding the call. */}
										{one.relay && (
											<span className="truncate text-[11px] text-fg-muted">
												<Flagged text={one.relay} />
											</span>
										)}
									</button>
								</li>
							))}
						</ul>
					)}
				</Card>

				<Card title="Known" note="Rooms this server has seen">
					{known.length === 0 ? (
						<Empty>None yet.</Empty>
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

				{/* Last of the three, and the order is the argument: what is
				    happening, what has happened, and what may happen next. Put
				    above the live rooms it would push the reason anybody opened
				    this panel below the fold. */}
				<OpeningCard canModerate={canModerate} onSignedOut={onSignedOut} />
			</div>

			{open ? (
				<People
					room={open}
					onBack={() => setSelected(undefined)}
					canModerate={canModerate}
					acting={acting}
					relays={relays}
					onSignedOut={onSignedOut}
					onClose={() => act(() => api.closeRoom(open))}
					onPlace={(relay, now) => {
						void act(async () => {
							await api.placeRoom(open, relay, now);
						});
					}}
					onPlacePerson={(identity, relay) => {
						void act(async () => {
							await api.placePerson(open, identity, relay);
						});
					}}
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
	onBack,
	canModerate,
	acting,
	relays,
	onSignedOut,
	onClose,
	onPlace,
	onPlacePerson,
	onRemove,
	onMute,
}: {
	room: string;
	onBack: () => void;
	canModerate: boolean;
	acting: boolean;
	relays: Relay[];
	onSignedOut: () => void;
	onClose: () => void;
	onPlace: (relay: string, now: boolean) => void;
	onPlacePerson: (identity: string, relay: string) => void;
	onRemove: (identity: string) => void;
	onMute: (identity: string, track: string) => void;
}) {
	const ask = useCallback(() => api.participants(room), [room]);
	const { value, error } = usePoll(ask, { onSignedOut });

	// Asked once rather than done at once. Nothing else on this panel ends a call
	// for everybody in it, and it used to be one press away from a list somebody
	// is scrolling.
	const [ending, setEnding] = useState(false);

	const people = value ?? [];

	// Read off whoever is in the room rather than passed down. The list beside
	// this one holds the same two facts and would have to thread them through
	// two components to say them here, and they are the same answer either way:
	// everybody in one room is on one machine, because a meeting lives on one.
	const held = people.find((one) => one.holding || one.relay)?.holding ?? people[0]?.relay;
	const started = people.reduce<string | undefined>(
		(first, one) => (!first || one.joinedAt < first ? one.joinedAt : first),
		undefined,
	);

	return (
		<Card
			title={room}
			note={`${people.length} ${people.length === 1 ? "person" : "people"}`}
			className="self-start"
			actions={
				// The way back, carrying nothing but its own arrow: the room's
				// name is already the title beside it.
				<Button variant="ghost" size="sm" onClick={onBack} className="gap-1 lg:hidden">
					<ChevronLeft className="size-3.5" />
					Rooms
				</Button>
			}
		>
			{error && <Failed>{error}</Failed>}

			{/*
			 * What this room is, before what can be done to it.
			 *
			 * The panel used to open with a red button and a list of names. The
			 * button was the loudest thing on the page and the one nobody wants to
			 * press by accident, and the two facts an operator actually came for —
			 * which machine is carrying this and how long it has been going — were
			 * nowhere at all: they had to be read off a row in the list beside,
			 * one participant at a time.
			 */}
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-border border-b px-4 py-2.5 text-[11.5px] text-fg-muted">
				{held && (
					<span className="flex items-center gap-1.5">
						<Server className="size-3" />
						<Flagged text={held} />
					</span>
				)}

				{/*
				 * Where the next call under this name is held, and — separately —
				 * moving the one in progress.
				 *
				 * A meeting lives on one machine and the media server has no way
				 * to hand it to another while it runs, so those are two different
				 * actions rather than one with a caveat. Choosing a relay sets
				 * where the next one goes; moving it now ends this call so
				 * everybody comes back to the machine that was chosen, and says so
				 * before it does.
				 */}
				{canModerate && relays.length > 0 && (
					<Moving
						relays={relays}
						acting={acting}
						onPlace={(relay, now) => onPlace(relay, now)}
					/>
				)}

				{started && (
					<span className="flex items-center gap-1.5">
						<Clock className="size-3" />
						{since(started)}
					</span>
				)}

				{canModerate && (
					<span className="ml-auto">
						{ending ? (
							<span className="flex items-center gap-2">
								<span className="text-fg">Everybody is disconnected.</span>

								<button
									type="button"
									disabled={acting}
									onClick={onClose}
									className={cn(
										"rounded-md bg-danger px-2 py-1 text-[11px] text-danger-fg",
										"transition-opacity hover:opacity-90 disabled:opacity-40",
									)}
								>
									Close it
								</button>

								<button
									type="button"
									onClick={() => setEnding(false)}
									className="rounded-md border border-border px-2 py-1 text-[11px] hover:bg-surface-hi"
								>
									Cancel
								</button>
							</span>
						) : (
							/*
							 * Quiet until it is asked for. Ending a call for eleven
							 * people is not undoable and had no step in front of it,
							 * sitting where a press meant for the list would land.
							 */
							<button
								type="button"
								onClick={() => setEnding(true)}
								className={cn(
									"flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px]",
									"text-fg-muted transition-colors hover:bg-danger/10 hover:text-fg",
								)}
							>
								<DoorClosed className="size-3" />
								Close this room
							</button>
						)}
					</span>
				)}
			</div>

			{people.length === 0 ? (
				<Empty>Nobody is here.</Empty>
			) : (
				<ul>
					{people.map((one) => (
						<Person
							key={one.sid}
							relays={relays}
							onPlace={(relay) => onPlacePerson(one.identity, relay)}
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
	relays,
	onPlace,
	onRemove,
	onMute,
}: {
	person: Participant;
	canModerate: boolean;
	acting: boolean;
	relays: Relay[];
	onPlace: (relay: string) => void;
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

				{canModerate && relays.length > 0 && (
					<Sending relays={relays} acting={acting} onPlace={onPlace} />
				)}

				{canModerate && (
					// An icon with a name on it, matching every other row on these
					// pages. A word floating at the end of a line reads as part of
					// the line rather than as something to press, which is how a
					// list of people came to look like it could not be acted on.
					<button
						type="button"
						disabled={acting}
						onClick={onRemove}
						aria-label="Remove from the call"
						title="Remove from the call"
						className={cn(
							"rounded-md border border-border p-1.5 text-fg-muted transition-colors",
							"hover:bg-surface-hi hover:text-danger disabled:opacity-40",
						)}
					>
						<UserMinus className="size-3.5" />
					</button>
				)}
			</div>

			{/*
			  * Where this person came from and how they got here.
			  *
			  * None of it is knowable from the media server. It sees each
			  * participant over a signalling socket opened by a relay, so the
			  * address it holds is the relay's and the machine it names is
			  * whichever node was asked. This deployment saw the real address and
			  * chose the machine, once, at the join, and wrote both down — which
			  * is the only record of either.
			  *
			  * Absent for anybody who joined before this existed, and left absent
			  * rather than filled with a dash: a blank says nothing was recorded,
			  * and a dash reads as a value.
			  */}
			{(person.address || person.relay) && (
				<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-muted">
					{person.address && <span className="readout">{person.address}</span>}

					{person.relay && (
						<span className="flex items-center gap-1">
							<LogIn className="size-3" />
							<Flagged text={person.relay} />
						</span>
					)}

					{/* Two machines and an arrow, only where there are two. A call
					    entering one relay and being carried by another is the thing
					    an operator most wants to see at a glance, and the thing
					    they cannot see anywhere else. */}
					{person.holding && (
						<span className="flex items-center gap-1">
							<ArrowRight className="size-3" />
							<Flagged text={person.holding} />
							{person.forwarded && (
								<span className="rounded bg-tally/15 px-1.5 py-px text-[10px] text-fg">
									forwarded
								</span>
							)}
						</span>
					)}
				</div>
			)}

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
		// Two lines rather than one. What it is and how it is encoded is one
		// thought; the layers underneath are another, and together they wanted
		// four hundred and thirty points on a screen with three hundred.
		<li className="rounded-md bg-surface-hi/50 px-2.5 py-1.5">
			<div className="flex items-baseline gap-x-3 text-xs">
				<span className="shrink-0 text-fg-muted">{source(track.source)}</span>
				<span className="readout text-[11px]">{codec || "—"}</span>

				{track.width > 0 && (
					<span className="readout text-[11px] tabular-nums">
						{track.width}×{track.height}
					</span>
				)}

				{track.muted && <span className="text-fg-muted text-[11px]">muted</span>}

				{canModerate && !track.muted && (
					// The same shape as every other action on these pages: an icon
					// that says what it does when pointed at. A bare word at the end
					// of a line of figures reads as another figure.
					<button
						type="button"
						disabled={acting}
						onClick={onMute}
						aria-label="Mute this"
						title="Mute this"
						className={cn(
							"ml-auto shrink-0 rounded p-1 text-fg-muted transition-colors",
							"hover:bg-surface-hi hover:text-fg disabled:opacity-40",
						)}
					>
						<MicOff className="size-3.5" />
					</button>
				)}
			</div>

			{track.layers.length > 0 && (
				<p className="readout mt-0.5 text-[11px] text-fg-muted tabular-nums">
					{track.layers.map((layer) => `${layer.height}p ${bitrate(layer.bitrate)}`).join("  ·  ")}
				</p>
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


/**
 * Moving a meeting to a different machine.
 *
 * Two presses, and the second one names what it does. A meeting lives on one
 * machine and the media server cannot hand it to another while it runs, so the
 * choice and the disruption are separate: picking a relay settles where the next
 * call under this name goes, and moving it now ends the one in progress so
 * everybody comes back to the machine that was picked.
 *
 * Said in the button rather than in a warning beside it. A control that ends a
 * call must not be pressed by somebody who thought it would not, and the place
 * they are certainly reading is the thing they are about to press.
 */
function Moving({
	relays,
	acting,
	onPlace,
}: {
	relays: Relay[];
	acting: boolean;
	onPlace: (relay: string, now: boolean) => void;
}) {
	const [open, setOpen] = useState(false);
	const [wanted, setWanted] = useState("");
	const { mounted, leaving } = useLingering(open, 160);

	return (
		<span className="relative">
			<button
				type="button"
				onClick={() => setOpen((was) => !was)}
				className={cn(
					"flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px]",
					"text-fg-muted transition-colors hover:bg-surface-hi hover:text-fg",
				)}
			>
				<Move className="size-3" />
				Move
			</button>

			{mounted && (
				<div
					className={cn(
						"absolute top-full left-0 z-20 mt-1.5 flex w-64 flex-col gap-1.5",
						"rounded-xl border border-border bg-surface-hi p-2 shadow-2xl ring-1 ring-black/40",
						"origin-top",
						leaving ? "animate-depart" : "animate-arrive",
					)}
				>
					<select
						value={wanted}
						onChange={(event) => setWanted(event.target.value)}
						className="rounded-md border border-border bg-surface-hi px-2 py-1.5 text-[12px] outline-none"
					>
						<option value="">Choose a machine</option>
						{relays.map((relay) => (
							<option key={relay.name} value={relay.name}>
								{relay.label || relay.name}
							</option>
						))}
					</select>

					<button
						type="button"
						disabled={!wanted || acting}
						onClick={() => {
							onPlace(wanted, false);
							setOpen(false);
						}}
						className={cn(
							"rounded-md border border-border px-2 py-1.5 text-left text-[11.5px]",
							"transition-colors hover:bg-surface-hi disabled:opacity-40",
						)}
					>
						Hold the next call here
					</button>

					<button
						type="button"
						disabled={!wanted || acting}
						onClick={() => {
							onPlace(wanted, true);
							setOpen(false);
						}}
						className={cn(
							"rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 text-left text-[11.5px]",
							"transition-colors hover:bg-danger/20 disabled:opacity-40",
						)}
					>
						Move now, ending this call
					</button>
				</div>
			)}
		</span>
	);
}

/**
 * Sending one person in through a different relay.
 *
 * Where somebody enters is theirs — their browser measures and picks — and this
 * takes it over for one join, which is the whole of what an operator can
 * honestly do: a browser holds its connection to the machine it dialled, and
 * nothing in the protocol asks it to move. So they are let go of, and the door
 * they come back through is the one chosen here.
 */
function Sending({
	relays,
	acting,
	onPlace,
}: {
	relays: Relay[];
	acting: boolean;
	onPlace: (relay: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const { mounted, leaving } = useLingering(open, 160);

	return (
		<span className="relative">
			<button
				type="button"
				disabled={acting}
				onClick={() => setOpen((was) => !was)}
				aria-label="Send in through another relay"
				title="Send in through another relay"
				className={cn(
					"rounded-md border border-border p-1.5 text-fg-muted transition-colors",
					"hover:bg-surface-hi hover:text-fg disabled:opacity-40",
				)}
			>
				<Move className="size-3.5" />
			</button>

			{mounted && (
				<div
					className={cn(
						"absolute top-full right-0 z-20 mt-1.5 flex w-56 flex-col gap-1.5",
						"rounded-xl border border-border bg-surface-hi p-2 shadow-2xl ring-1 ring-black/40",
						"origin-top",
						leaving ? "animate-depart" : "animate-arrive",
					)}
				>
					<p className="px-0.5 text-[10.5px] text-fg-muted leading-snug">
						They are dropped from the call and come back in through this one.
					</p>

					{relays.map((relay) => (
						<button
							key={relay.name}
							type="button"
							onClick={() => {
								onPlace(relay.name);
								setOpen(false);
							}}
							className="rounded-md px-2 py-1 text-left text-[12px] transition-colors hover:bg-surface-hi"
						>
							<Flagged text={relay.label || relay.name} />
						</button>
					))}
				</div>
			)}
		</span>
	);
}
