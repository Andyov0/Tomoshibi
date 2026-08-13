import { ControlBar } from "@/components/room/ControlBar";
import { FocusLayout } from "@/components/room/FocusLayout";
import { GridLayout, TILES_PER_PAGE } from "@/components/room/GridLayout";
import { ShareCard } from "@/components/room/ShareCard";
import { StageControls } from "@/components/room/StageControls";
import { SurfaceTile } from "@/components/room/SurfaceTile";
import { useFullscreen } from "@/hooks/useFullscreen";
import { usePagination } from "@/hooks/usePagination";
import { usePin } from "@/hooks/usePin";
import { useConnection, useRoster } from "@/hooks/useRoomState";
import { impersonating } from "@/live/name";
import { type Surface, owner, surfaces } from "@/live/surface";
import { ConnectionState, type Room as LiveRoom } from "livekit-client";
import type { ReactNode } from "react";

export interface RoomProps {
	room: LiveRoom;
	onLeave: () => void;
}

export function Room({ room, onLeave }: RoomProps) {
	return (
		<div className="flex h-full flex-col">
			<Stage room={room} />
			<ControlBar room={room} onLeave={onLeave} />
		</div>
	);
}

function Stage({ room }: { room: LiveRoom }) {
	const participants = useRoster(room);
	const state = useConnection(room);
	const screen = useFullscreen<HTMLDivElement>();

	const all = surfaces(participants, room.localParticipant.identity);
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

	const tile = (surface: Surface, onStage: boolean): ReactNode => {
		if (surface.kind === "screen" && !onStage) {
			return (
				<ShareCard
					key={surface.id}
					label={owner(surface).name || owner(surface).identity}
					onOpen={() => pin(surface)}
				/>
			);
		}

		return (
			<SurfaceTile
				key={surface.id}
				surface={surface}
				subscribed={onStage || surface.kind === "camera"}
				unverified={suspect.has(owner(surface).identity)}
				selected={onStage}
				onSelect={() => toggle(surface)}
				onExpand={onStage ? screen.toggle : undefined}
			/>
		);
	};

	const mine = self
		? [
				<SurfaceTile
					key={self.id}
					surface={self}
					unverified={suspect.has(owner(self).identity)}
					onSelect={() => toggle(self)}
				/>,
			]
		: [];

	return (
		<main className="relative min-h-0 flex-1">
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

			{state !== ConnectionState.Connected && (
				<div className="-translate-x-1/2 pointer-events-none absolute top-3 left-1/2 rounded-full bg-surface-hi px-3 py-1 text-fg-muted text-xs shadow">
					{state === ConnectionState.Reconnecting ? "Reconnecting…" : "Connecting…"}
				</div>
			)}
		</main>
	);
}
