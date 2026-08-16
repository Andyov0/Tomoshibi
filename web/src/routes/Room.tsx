import { Audible } from "@/components/room/Audible";
import { ChatPanel } from "@/components/room/ChatPanel";
import { ControlBar } from "@/components/room/ControlBar";
import { EmptyRoom } from "@/components/room/EmptyRoom";
import { PictureMenu } from "@/components/room/PictureMenu";
import { Plane } from "@/components/room/Plane";
import { RoomMenu } from "@/components/room/RoomMenu";
import { Signal } from "@/components/room/Signal";
import { useConnectionQuality } from "@/live/connection";
import { ShareCard } from "@/components/room/ShareCard";
import { SoundPanel } from "@/components/room/SoundPanel";
import { SaidInCorner, SaidOnTile } from "@/components/room/Said";
import { StageControls } from "@/components/room/StageControls";
import { SurfaceTile } from "@/components/room/SurfaceTile";
import { useChat } from "@/hooks/useChat";
import { useFullscreen } from "@/hooks/useFullscreen";
import { useHearing } from "@/hooks/useHearing";
import { useMeasure } from "@/hooks/useMeasure";
import { usePagination } from "@/hooks/usePagination";
import { usePin } from "@/hooks/usePin";
import { useConnection, useRoster } from "@/hooks/useRoomState";
import { useSpeakingOrder } from "@/hooks/useSpeakingOrder";
import { useT } from "@/hooks/useT";
import { watch } from "@/live/notices";
import { impersonating } from "@/live/name";
import type { Said } from "@/live/chat";
import {
	ALONE_TOGETHER,
	TILES_PER_PAGE,
	planClose,
	planFocus,
	planGrid,
	stripCapacity,
} from "@/live/plan";
import { silenced, soundOf } from "@/live/hearing";
import { type Surface, owner, surfaces } from "@/live/surface";
import { ConnectionState, type Room as LiveRoom } from "livekit-client";
import { useCallback, useEffect, useState } from "react";

export interface RoomProps {
	room: LiveRoom;
	onLeave: () => void;
}

export function Room({ room, onLeave }: RoomProps) {
	// One at a time, because both float over the same corner and the second
	// would simply be drawn on top of the first.
	const [panel, setPanel] = useState<"messages" | "sound">();
	const chat = useChat(room, panel === "messages");
	const screen = useFullscreen<HTMLDivElement>();

	const chatting = panel === "messages";
	const listening = panel === "sound";

	// Arrivals, departures, and somebody taking the stage with a share.
	useEffect(() => watch(room), [room]);

	/*
	 * Said on the document, because the one thing that needs to know is a
	 * stylesheet. Notices sit along the bottom edge of a hand-held screen and so
	 * do these controls, and the notices have to clear them — which is a fact
	 * about this screen rather than about any component either of them can see.
	 */
	useEffect(() => {
		document.body.dataset.island = "";

		return () => {
			delete document.body.dataset.island;
		};
	}, []);

	const openChat = useCallback(() => {
		setPanel("messages");
		chat.markRead();
	}, [chat.markRead]);

	return (
		<div className="relative h-full">
			<Stage
				room={room}
				chat={chat}
				chatting={chatting}
				listening={listening}
				screen={screen}
				onClosePanel={() => setPanel(undefined)}
				onOpenSound={() => setPanel("sound")}
			/>
			<ControlBar
				room={room}
				chatting={chatting}
				unread={chat.unread}
				listening={listening}
				hidden={screen.active}
				onChat={() => (chatting ? setPanel(undefined) : openChat())}
				onListen={() => setPanel(listening ? undefined : "sound")}
				onLeave={onLeave}
			/>
			{/* Outside the stage on purpose: what people can hear must not depend
			    on what the layout happens to be drawing. */}
			<Audible room={room} />
		</div>
	);
}

function Stage({
	room,
	chat,
	chatting,
	listening,
	screen,
	onClosePanel,
	onOpenSound,
}: {
	room: LiveRoom;
	chat: ReturnType<typeof useChat>;
	chatting: boolean;
	listening: boolean;
	screen: ReturnType<typeof useFullscreen<HTMLDivElement>>;
	onClosePanel: () => void;
	onOpenSound: () => void;
}) {
	const t = useT();
	const heard = useHearing();
	const participants = useRoster(room);
	const state = useConnection(room);

	// Measured in the browser rather than reported by the server, because the
	// question it answers is about this end of the call.
	const connection = useConnectionQuality(room);
	const [measure, size] = useMeasure();

	// Whoever has spoken recently comes forward, but only once there are more
	// people than fit on a page. Below that the order holds still, since a grid
	// that rearranges itself when somebody speaks is worse than one that does
	// not.
	const crowded = participants.length > TILES_PER_PAGE;
	const ordered = useSpeakingOrder(participants, crowded);

	const all = surfaces(ordered, room.localParticipant.identity);
	const { pinned, toggle, pin } = usePin(all);

	// Taking the last picture off the stage leaves nothing to fill the screen
	// with. The element holding it is the same one in either arrangement now, so
	// it no longer leaves on its own when the stage empties — and a screen still
	// filled by a grid nobody asked to see is one somebody has to press Escape to
	// get out of.
	const { exit } = screen;
	useEffect(() => {
		if (!pinned) exit();
	}, [pinned, exit]);

	// Worked out here rather than inside a tile, because the question is about
	// the room: whether anybody unsigned is wearing a name somebody else signed.
	// A tile can only see itself.
	const roster = participants.map((p) => ({ name: p.name ?? "", identity: p.identity }));
	const suspect = new Set(roster.filter((p) => impersonating(p, roster)).map((p) => p.identity));

	// Our own camera never pages away. Losing sight of your own picture because
	// the room got busy is disorienting, and it costs nothing since it renders
	// from the local capture.
	const self = all.find((surface) => surface.local && surface.kind === "camera");
	const mine = self && self.id !== pinned?.id ? [self] : [];
	const rest = all.filter((surface) => surface !== self && surface.id !== pinned?.id);

	// The filmstrip holds what the width allows; the grid holds a fixed nine.
	// Either way our own picture takes one of the places rather than being added
	// beyond them.
	const capacity = pinned ? stripCapacity(size) : TILES_PER_PAGE;
	const paged = usePagination(rest, Math.max(1, capacity - mine.length));
	const shown = [...mine, ...paged.items].map((surface) => surface.id);

	// Two people is not a grid of two, and on a phone the grid of two was
	// measured at fifty-six per cent of the screen. One person fills it and the
	// other is a card, which is what a telephone has always done.
	//
	// Named rather than asserted: the condition below and the picture it needs
	// are then one thing a reader can see is true, instead of two that have to
	// be checked against each other.
	const alone = all.length <= ALONE_TOGETHER ? rest[0] : undefined;

	const plan = pinned
		? planFocus(size, pinned.id, screen.active ? [] : shown, { fullscreen: screen.active })
		: alone
			? planClose(size, alone.id, self ? [self.id] : [])
			: planGrid(size, shown);

	// Somebody sharing their screen is two pictures. Whichever is not on the
	// stage is what the switch on the stage offers, and finding it here is the
	// only place that knows both the pin and the whole roster.
	const counterpart = pinned
		? all.find(
				(surface) => surface.id !== pinned.id && owner(surface).identity === owner(pinned).identity,
			)
		: undefined;

	// Whoever is on screen carries their own words. Anybody who is not — on
	// another page, or hidden behind a share — falls back to the corner, which
	// is the only place a message needs a face and a name of its own.
	//
	// Read from the plan rather than counted while rendering: every picture is
	// rendered now, including the ones nobody can see, so being rendered no
	// longer means being visible.
	const seen = new Set(
		all.filter((surface) => plan.has(surface.id)).map((surface) => owner(surface).identity),
	);
	const saidOn = (surface: Surface): Said[] =>
		plan.has(surface.id) ? (chat.showing.get(owner(surface).identity) ?? []) : [];

	/**
	 * One picture, in whichever of its two forms suits where it is.
	 *
	 * Built for every surface in the room, not only the ones on screen: the plan
	 * decides where each goes, and a picture that is nowhere is simply moved out
	 * of sight. Rendering only what is visible is what used to make putting
	 * somebody on the stage cost a black screen.
	 */
	const tile = (surface: Surface) => {
		const onStage = surface.id === pinned?.id;

		// Our own pictures are never marked: nobody hears themselves, so there
		// is no setting behind the mark and it would be a symbol with no cause.
		const quiet =
			!surface.local && silenced(heard(owner(surface).identity, soundOf(surface.kind)));

		if (surface.kind === "screen" && !onStage) {
			return (
				<ShareCard
					label={owner(surface).name || owner(surface).identity}
					silenced={quiet}
					onOpen={() => pin(surface)}
				/>
			);
		}

		return (
			<SurfaceTile
				surface={surface}
				unverified={suspect.has(owner(surface).identity)}
				silenced={quiet}
				selected={onStage}
				overlay={
					<>
						<SaidOnTile said={saidOn(surface)} compact={!onStage && pinned !== undefined} />
						{onStage && (
							<StageControls
								other={counterpart}
								onSwitch={pin}
								fullscreen={screen.active}
								onFullscreen={screen.toggle}
								fullscreenSupported={screen.supported}
							/>
						)}
					</>
				}
				onSelect={() => toggle(surface)}
				onExpand={onStage ? screen.toggle : undefined}
			/>
		);
	};

	return (
		<main className="relative h-full">
			{/* Top left, out of the way of the room's own name in the middle and of
			    anything a menu opens on the right. Pointer events off on the frame so
			    it never eats a click meant for a picture underneath. */}
			{state === ConnectionState.Connected && (
				<div className="pointer-events-none absolute top-3 left-3 z-10">
					<Signal reading={connection} />
				</div>
			)}

			{/* The element that fills the screen. It holds the pictures and nothing
			    else, so a fullscreen stage is a stage rather than a room with its
			    chrome still attached. */}
			<RoomMenu>
				<div ref={screen.ref} className="h-full w-full bg-bg">
					<Plane
					measure={measure}
					plan={plan}
					page={paged.page}
					pages={paged.pages}
					onNext={paged.next}
					onPrevious={paged.previous}
					tiles={all.map((surface) => ({
						id: surface.id,
						node: (
							<PictureMenu
								surface={surface}
								onStage={surface.id === pinned?.id}
								fullscreen={screen.active}
								fullscreenSupported={screen.supported}
								onToggleStage={() => toggle(surface)}
								onFullscreen={screen.toggle}
								onOpenSound={onOpenSound}
							>
								<div className="size-full animate-arrive">{tile(surface)}</div>
							</PictureMenu>
						),
					}))}
					/>
				</div>
			</RoomMenu>

			{/* Placed over the grid rather than instead of it, so the self view
			    stays where it will be when somebody arrives. */}
			{rest.length === 0 && !pinned && state === ConnectionState.Connected && (
				<div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
					<div className="pointer-events-auto">
						<EmptyRoom />
					</div>
				</div>
			)}

			{chatting && (
				<ChatPanel
					said={chat.all}
					onSay={chat.send}
					sending={chat.sending}
					offline={state !== ConnectionState.Connected}
					onClose={onClosePanel}
				/>
			)}

			{listening && <SoundPanel room={room} onClose={onClosePanel} />}

			{/* Only for people with no tile to borrow. */}
			<SaidInCorner
				said={[...chat.showing.entries()]
					.filter(([identity]) => !seen.has(identity))
					.flatMap(([, said]) => said)}
			/>

			{state !== ConnectionState.Connected && (
				<div className="-translate-x-1/2 pointer-events-none absolute top-3 left-1/2 rounded-full bg-surface-hi px-3 py-1 text-fg-muted text-xs shadow">
					{state === ConnectionState.Reconnecting ? t("Reconnecting…") : t("Connecting…")}
				</div>
			)}
		</main>
	);
}
