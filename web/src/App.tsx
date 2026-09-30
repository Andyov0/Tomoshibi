import { join as requestJoin } from "@/live/api";
import { generateRoomName, normaliseRoomName, validRoomName } from "@/live/names";
import { connect, create } from "@/live/room";
import { deviceFailed, joinFailed, sentAway } from "@/live/notices";
import { type Choices, PreJoin } from "@/routes/PreJoin";
import { Room } from "@/routes/Room";
import { type DisconnectReason, type Room as LiveRoom, RoomEvent } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The room this page is for, generating one if the address does not name it.
 *
 * Arriving at the bare address means a new meeting, so one is made rather than
 * everybody being funnelled into a shared default. A shared default is a room
 * that strangers walk into, which is a worse outcome than a name nobody asked
 * for.
 *
 * Replaced rather than pushed: the address without a room is a state to pass
 * through, and leaving it in the history means the back button returns to a page
 * that generates a different room every time it is visited.
 */
function initialRoom(): string {
	const raw = normaliseRoomName(window.location.hash.replace(/^#\/?/, ""));

	if (validRoomName(raw)) {
		return raw;
	}

	const made = generateRoomName();
	window.history.replaceState(null, "", `#/${made}`);

	return made;
}

export function App() {
	const [room, setRoom] = useState(initialRoom);
	const [live, setLive] = useState<LiveRoom>();

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

	// The address follows the room, so the link somebody copies is the room they
	// are looking at, and the back button moves between rooms rather than
	// between edits to a name.
	useEffect(() => {
		if (window.location.hash !== `#/${room}`) {
			window.history.replaceState(null, "", `#/${room}`);
		}
	}, [room]);

	// Someone else may have changed it: a pasted link, or the back button.
	useEffect(() => {
		const onHashChange = () => {
			const raw = normaliseRoomName(window.location.hash.replace(/^#\/?/, ""));
			if (validRoomName(raw)) setRoom(raw);
		};

		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);

	// What was asked for on the first screen, waiting for the room to be shown.
	const wanted = useRef<{ camera: boolean; microphone: boolean }>();

	const onJoin = useCallback(
		async ({ name, passphrase, camera, microphone }: Choices) => {
			const made = create();

			try {
				const grant = await requestJoin(room, name, passphrase);
				await connect(made, grant);
			} catch (err) {
				void made.disconnect();
				joinFailed(err instanceof Error ? err.message : String(err));
				return;
			}

			wanted.current = { camera, microphone };
			current.current = made;
			setLive(made);
		},
		[room],
	);

	/*
	 * The camera and microphone, once the room is on screen.
	 *
	 * They used to be switched on inside the join, in the same try as the
	 * connection, so a device that failed failed the join: a microphone somebody
	 * had refused, or a camera another application was holding, disconnected a
	 * person who was already in and told them the room would not open. Now each
	 * one fails on its own, says so the way a device failing in the call does, and
	 * leaves somebody in the meeting with whatever did work.
	 *
	 * In an effect rather than straight after connecting, because the first
	 * screen's preview is still holding the camera until that screen is gone,
	 * and React stops it on the way out of the same commit that mounts the room.
	 * Asking for the camera a second time while the preview has it is exactly the
	 * "something else is using it" that some systems refuse.
	 *
	 * After connecting rather than before, so somebody appears in the room the
	 * moment they join and their devices come up a beat later, instead of the room
	 * waiting on a camera that may never be granted.
	 */
	useEffect(() => {
		const asked = wanted.current;
		if (!live || !asked) return;
		wanted.current = undefined;

		const local = live.localParticipant;
		void local.setMicrophoneEnabled(asked.microphone).catch((err) => deviceFailed("microphone", err));
		void local.setCameraEnabled(asked.camera).catch((err) => deviceFailed("camera", err));
	}, [live]);

	// Let go of before disconnecting, since disconnecting is what announces the
	// end of the call, and the listener below answers that by leaving.
	const onLeave = useCallback(() => {
		const leaving = current.current;
		current.current = undefined;
		setLive(undefined);
		void leaving?.disconnect();
	}, []);

	/*
	 * The call ending from the other side.
	 *
	 * An administrator removing somebody or closing the room, the same identity
	 * joining from another tab, or a reconnection that gave up. None of these was
	 * listened for, so the room stayed on screen with every picture frozen and
	 * "Connecting…" over it, and the camera and microphone went on being held
	 * until somebody thought to press Leave. The first screen is the honest
	 * place to be once the call is over, and the notice says why they are there.
	 */
	useEffect(() => {
		if (!live) return;

		const onDisconnected = (reason?: DisconnectReason) => {
			sentAway(reason);
			if (current.current === live) onLeave();
		};

		live.on(RoomEvent.Disconnected, onDisconnected);
		return () => {
			live.off(RoomEvent.Disconnected, onDisconnected);
		};
	}, [live, onLeave]);

	if (live) {
		return <Room room={live} onLeave={onLeave} />;
	}

	return <PreJoin room={room} onRoomChange={setRoom} onJoin={onJoin} />;
}
