import { join as requestJoin } from "@/live/api";
import { generateRoomName, normaliseRoomName, validRoomName } from "@/live/names";
import { connect, create } from "@/live/room";
import { joinFailed } from "@/live/notices";
import { type Choices, PreJoin } from "@/routes/PreJoin";
import { Room } from "@/routes/Room";
import type { Room as LiveRoom } from "livekit-client";
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
	// What the machine holding the call is called, so it can be said in the words
	// the picker used rather than as an address.
	const [holding, setHolding] = useState<string>();

	// And the machine it is actually on, where the two came apart. Undefined for
	// most calls, which is what makes the panel say one name rather than two.
	const [carrying, setCarrying] = useState<string>();

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

	const onJoin = useCallback(
		async ({ name, passphrase, camera, microphone, relay }: Choices) => {

			const made = create();

			try {
				const grant = await requestJoin(room, name, passphrase, relay);
				// Kept so the call can say where it is being held, in the words
				// the picker used rather than as an address.
				setHolding(grant.relay);
				setCarrying(grant.holding);
				await connect(made, grant);

				// After connecting rather than before, so somebody appears in the
				// room the moment they join and their devices come up a beat
				// later, instead of the room waiting on a camera that may never
				// be granted.
				await made.localParticipant.setMicrophoneEnabled(microphone);
				await made.localParticipant.setCameraEnabled(camera);

				current.current = made;
				setLive(made);
			} catch (err) {
				void made.disconnect();
				joinFailed(err instanceof Error ? err.message : String(err));
			}
		},
		[room],
	);

	const onLeave = useCallback(() => {
		void current.current?.disconnect();
		current.current = undefined;
		setLive(undefined);
	}, []);

	if (live) {
		return <Room room={live} relay={holding} carrying={carrying} onLeave={onLeave} />;
	}

	return <PreJoin room={room} onRoomChange={setRoom} onJoin={onJoin} />;
}
