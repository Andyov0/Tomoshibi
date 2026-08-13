import { ControlBar } from "@/components/room/ControlBar";
import { FocusLayout } from "@/components/room/FocusLayout";
import { GridLayout, TILES_PER_PAGE } from "@/components/room/GridLayout";
import { ShareCard } from "@/components/room/ShareCard";
import { SurfaceTile } from "@/components/room/SurfaceTile";
import { usePagination } from "@/hooks/usePagination";
import { usePin } from "@/hooks/usePin";
import { useConnection, useRoster } from "@/hooks/useRoomState";
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

	const all = surfaces(participants, room.localParticipant.identity);
	const { pinned, toggle, pin } = usePin(all);

	// Our own camera never pages away; everybody else shares the rest of the
	// page. Losing sight of your own picture because the room got busy is
	// disorienting, and it costs nothing since it renders from the local capture.
	const self = all.find((surface) => surface.local && surface.kind === "camera");
	const others = all.filter((surface) => surface !== self);
	const grid = usePagination(others, TILES_PER_PAGE - 1);

	/**
	 * Render one surface.
	 *
	 * A screen share only gets a real subscription on the stage; anywhere else it
	 * is a card, which is both cheaper and more readable than an illegible
	 * thumbnail of somebody's desktop.
	 */
	const render = (surface: Surface, onStage: boolean): ReactNode => {
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
				onDoubleClick={() => toggle(surface)}
			/>
		);
	};

	const mine = self ? [<SurfaceTile key={self.id} surface={self} />] : [];

	return (
		<main className="relative min-h-0 flex-1">
			{pinned ? (
				<FocusLayout
					stage={render(pinned, true)}
					strip={[
						...mine,
						...others.filter((s) => s.id !== pinned.id).map((s) => render(s, false)),
					]}
				/>
			) : (
				<GridLayout
					page={grid.page}
					pages={grid.pages}
					onNext={grid.next}
					onPrevious={grid.previous}
				>
					{[...mine, ...grid.items.map((s) => render(s, false))]}
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
