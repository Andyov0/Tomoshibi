import { PreJoin, type Choices } from "@/routes/PreJoin";
import { Room } from "@/routes/Room";
import { join as requestJoin } from "@/live/api";
import { connect, create } from "@/live/room";
import type { Room as LiveRoom } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";

/** The room name from `#/room-name`, defaulting to a shared lobby. */
function roomFromHash(): string {
	const raw = window.location.hash.replace(/^#\/?/, "").trim().toLowerCase();
	return raw || "lobby";
}

export function App() {
	const [room, setRoom] = useState<LiveRoom>();
	const [error, setError] = useState<string>();

	// Held in a ref as well so the unmount cleanup can reach it without making
	// the effect depend on it, which would disconnect on every render.
	const current = useRef<LiveRoom>();

	useEffect(
		() => () => {
			void current.current?.disconnect();
			current.current = undefined;
		},
		[],
	);

	const onJoin = useCallback(async ({ name, camera, microphone }: Choices) => {
		setError(undefined);

		const made = create();

		try {
			const grant = await requestJoin(roomFromHash(), name);
			await connect(made, grant);

			// After connecting rather than before, so somebody appears in the room
			// the moment they join and their devices come up a beat later, instead
			// of the room waiting on a camera that may never be granted.
			await made.localParticipant.setMicrophoneEnabled(microphone);
			await made.localParticipant.setCameraEnabled(camera);

			current.current = made;
			setRoom(made);
		} catch (err) {
			void made.disconnect();
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	const onLeave = useCallback(() => {
		void current.current?.disconnect();
		current.current = undefined;
		setRoom(undefined);
	}, []);

	if (room) {
		return <Room room={room} onLeave={onLeave} />;
	}

	return (
		<>
			<PreJoin onJoin={onJoin} />
			{error && (
				<p className="-translate-x-1/2 fixed bottom-6 left-1/2 rounded-lg bg-danger px-4 py-2 text-danger-fg text-sm">
					{error}
				</p>
			)}
		</>
	);
}
