import { ChatPanel } from "@/components/room/ChatPanel";
import { ControlBar } from "@/components/room/ControlBar";
import { FocusLayout } from "@/components/room/FocusLayout";
import { GridLayout, TILES_PER_PAGE } from "@/components/room/GridLayout";
import { EmptyRoom } from "@/components/room/EmptyRoom";
import { ShareCard } from "@/components/room/ShareCard";
import { SaidInCorner, SaidOnTile } from "@/components/room/Said";
import { StageControls } from "@/components/room/StageControls";
import { SurfaceTile } from "@/components/room/SurfaceTile";
import { useChat } from "@/hooks/useChat";
import { useFullscreen } from "@/hooks/useFullscreen";
import { usePagination } from "@/hooks/usePagination";
import { usePin } from "@/hooks/usePin";
import { useConnection, useRoster } from "@/hooks/useRoomState";
import { useSpeakingOrder } from "@/hooks/useSpeakingOrder";
import { say } from "@/live/chat";
import { impersonating } from "@/live/name";
import type { Said } from "@/live/chat";
import { type Surface, owner, surfaces } from "@/live/surface";
import { ConnectionState, type Room as LiveRoom } from "livekit-client";
import { type ReactNode, useCallback, useState } from "react";

export interface RoomProps {
	room: LiveRoom;
	onLeave: () => void;
}

export function Room({ room, onLeave }: RoomProps) {
	const [chatting, setChatting] = useState(false);
	const chat = useChat(room, chatting);
	const screen = useFullscreen<HTMLDivElement>();

	const openChat = useCallback(() => {
		setChatting(true);
		chat.markRead();
	}, [chat.markRead]);

	return (
		<div className="relative h-full">
			<Stage
				room={room}
				chat={chat}
				chatting={chatting}
				screen={screen}
				onCloseChat={() => setChatting(false)}
			/>
			<ControlBar
				room={room}
				chatting={chatting}
				unread={chat.unread}
				hidden={screen.active}
				onChat={() => (chatting ? setChatting(false) : openChat())}
				onLeave={onLeave}
			/>
		</div>
	);
}

function Stage({
	room,
	chat,
	chatting,
	screen,
	onCloseChat,
}: {
	room: LiveRoom;
	chat: ReturnType<typeof useChat>;
	chatting: boolean;
	screen: ReturnType<typeof useFullscreen<HTMLDivElement>>;
	onCloseChat: () => void;
}) {
	const participants = useRoster(room);
	const state = useConnection(room);

	// Whoever has spoken recently comes forward, but only once there are more
	// people than fit on a page. Below that the order holds still, since a grid
	// that rearranges itself when somebody speaks is worse than one that does
	// not.
	const crowded = participants.length > TILES_PER_PAGE;
	const ordered = useSpeakingOrder(participants, crowded);

	const all = surfaces(ordered, room.localParticipant.identity);
	const { pinned, toggle, pin } = usePin(all);

	// Worked out here rather than inside a tile, because the question is about
	// the room: whether anybody unsigned is wearing a name somebody else signed.
	// A tile can only see itself.
	const roster = participants.map((p) => ({ name: p.name ?? "", identity: p.identity }));
	const suspect = new Set(roster.filter((p) => impersonating(p, roster)).map((p) => p.identity));

	// Our own camera never pages away; everybody else shares the rest of the
	// page. Losing sight of your own picture because the room got busy is
	// disorienting, and it costs nothing since it renders from the local capture.
	const self = all.find((surface) => surface.local && surface.kind === "camera");
	const others = all.filter((surface) => surface !== self);
	const grid = usePagination(others, TILES_PER_PAGE - 1);

	// Somebody sharing their screen is two pictures. Whichever is not on the
	// stage is what the switch on the stage offers, and finding it here is the
	// only place that knows both the pin and the whole roster.
	const counterpart = pinned
		? all.find(
				(surface) => surface.id !== pinned.id && owner(surface).identity === owner(pinned).identity,
			)
		: undefined;

	/**
	 * Render one surface, wrapped so the grid can recognise it.
	 *
	 * `data-flip` is what lets the layout tell a tile that moved from a tile
	 * that arrived: the first is animated from where it used to be, the second
	 * is left to its own entrance.
	 */
	// Whoever is on screen carries their own words. Anybody who is not — on
	// another page, or hidden behind a share — falls back to the corner, which
	// is the only place a message needs a face and a name of its own.
	const visible = new Set<string>();
	const saidBy = (surface: Surface): Said[] => {
		const identity = owner(surface).identity;
		visible.add(identity);
		return chat.showing.get(identity) ?? [];
	};

	const inStrip = pinned !== undefined;

	const tile = (surface: Surface, onStage: boolean): ReactNode => {
		const inner =
			surface.kind === "screen" && !onStage ? (
				<ShareCard
					label={owner(surface).name || owner(surface).identity}
					onOpen={() => pin(surface)}
				/>
			) : (
				<SurfaceTile
					surface={surface}
					subscribed={onStage || surface.kind === "camera"}
					unverified={suspect.has(owner(surface).identity)}
					selected={onStage}
					overlay={<SaidOnTile said={saidBy(surface)} compact={!onStage && inStrip} />}
					onSelect={() => toggle(surface)}
					onExpand={onStage ? screen.toggle : undefined}
				/>
			);

		return (
			<div key={surface.id} data-flip={surface.id} className="size-full animate-arrive">
				{inner}
			</div>
		);
	};

	const mine = self
		? [
				<div key={self.id} data-flip={self.id} className="size-full animate-arrive">
					<SurfaceTile
						surface={self}
						unverified={suspect.has(owner(self).identity)}
						overlay={<SaidOnTile said={saidBy(self)} />}
						onSelect={() => toggle(self)}
					/>
				</div>,
			]
		: [];

	return (
		<main className="relative h-full">
			{pinned ? (
				<FocusLayout
					stageRef={screen.ref}
					fullscreen={screen.active}
					stage={tile(pinned, true)}
					controls={
						<StageControls
							other={counterpart}
							onSwitch={pin}
							fullscreen={screen.active}
							onFullscreen={screen.toggle}
							fullscreenSupported={screen.supported}
						/>
					}
					strip={[...mine, ...others.filter((s) => s.id !== pinned.id).map((s) => tile(s, false))]}
				/>
			) : (
				<GridLayout
					page={grid.page}
					pages={grid.pages}
					onNext={grid.next}
					onPrevious={grid.previous}
				>
					{[...mine, ...grid.items.map((s) => tile(s, false))]}
				</GridLayout>
			)}

			{/* Placed over the grid rather than instead of it, so the self view
			    stays where it will be when somebody arrives. */}
			{others.length === 0 && state === ConnectionState.Connected && (
				<div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
					<div className="pointer-events-auto">
						<EmptyRoom />
					</div>
				</div>
			)}

			{chatting && (
				<ChatPanel
					said={chat.all}
					onSay={(body) => void say(room, body)}
					onClose={onCloseChat}
				/>
			)}

			{/* Only for people with no tile to borrow. */}
			<SaidInCorner
				said={[...chat.showing.entries()]
					.filter(([identity]) => !visible.has(identity))
					.flatMap(([, said]) => said)}
			/>

			{state !== ConnectionState.Connected && (
				<div className="-translate-x-1/2 pointer-events-none absolute top-3 left-1/2 rounded-full bg-surface-hi px-3 py-1 text-fg-muted text-xs shadow">
					{state === ConnectionState.Reconnecting ? "Reconnecting…" : "Connecting…"}
				</div>
			)}
		</main>
	);
}
