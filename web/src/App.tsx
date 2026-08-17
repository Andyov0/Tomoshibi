import { type Me, inviteToken, invited, me as whoAmI } from "@/live/account";
import { deployment, join as requestJoin } from "@/live/api";
import { generateRoomName, normaliseRoomName, validRoomName } from "@/live/names";
import { connect, create } from "@/live/room";
import { joinFailed } from "@/live/notices";
import { Lobby, SignIn } from "@/routes/Lobby";
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

	return validRoomName(raw) ? raw : "";
}

/**
 * What the front of this deployment looks like before anybody is in a call.
 *
 * Four states and one question behind all of them: may whoever is looking start
 * a meeting? Where anybody may — which is what most deployments are and what
 * this one was — the answer is the old page, straight into a generated room,
 * because the fastest path to a meeting is to already be in it.
 *
 * Where they may not, that page puts a refusal at the end of choosing a camera
 * and typing a name. So the order inverts: say who you are, then say what you
 * want. And somebody who was sent a link is neither of those people — they have
 * no account and were not meant to need one — so an invite skips both and goes
 * to the room it names.
 */
type Front =
	| { at: "asking" }
	| { at: "open" }
	| { at: "sign in" }
	| { at: "lobby"; me: Me }
	| { at: "invited"; room: string };

export function App() {
	const [room, setRoom] = useState(initialRoom);
	const [front, setFront] = useState<Front>({ at: "asking" });
	const [live, setLive] = useState<LiveRoom>();
	// What the machine holding the call is called, so it can be said in the words
	// the picker used rather than as an address.
	const [holding, setHolding] = useState<string>();

	// And the machine it is actually on, where the two came apart. Undefined for
	// most calls, which is what makes the panel say one name rather than two.
	const [carrying, setCarrying] = useState<string>();

	// Worked out once, from two questions asked together.
	//
	// Together rather than one after the other, because the second is only
	// interesting if the first says the door is shut, and asking them in sequence
	// would put a visible pause in front of the common case where it is not.
	useEffect(() => {
		let live = true;

		const token = inviteToken();

		void Promise.all([deployment(), whoAmI(), token ? invited(token) : undefined]).then(
			([said, account, invitation]) => {
				if (!live) return;

				// An invite wins over everything. Somebody holding one was sent to
				// a particular meeting, and asking them to sign in first is asking
				// them for something they were never given.
				if (invitation?.room) {
					setRoom(invitation.room);
					setFront({ at: "invited", room: invitation.room });
					return;
				}

				// A deployment anybody may open a room on has no lobby, so the
				// bare address means a new meeting and one is made. Made here
				// rather than on load, which is what used to put a generated name
				// in the address bar of a page that had not decided to be a room
				// yet — somebody signing in read their own URL and found a room
				// they had not asked for.
				if (said.openedBy === "anyone") {
					setRoom((held) => held || generateRoomName());
					setFront({ at: "open" });
					return;
				}

				setFront(account ? { at: "lobby", me: account } : { at: "sign in" });
			},
		);

		return () => {
			live = false;
		};
	}, []);

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
		if (!room) return;

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
				const grant = await requestJoin(room, name, passphrase, relay, inviteToken());
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

	// Nothing rather than a spinner. The two requests behind this take one round
	// trip on a warm connection, and a spinner shown for that long is a flash
	// somebody notices without being able to read.
	if (front.at === "asking") return <div className="min-h-full bg-bg" />;

	if (front.at === "sign in") {
		return <SignIn onSignedIn={(account) => setFront({ at: "lobby", me: account })} />;
	}

	if (front.at === "lobby") {
		return (
			<Lobby
				me={front.me}
				onOpen={(wanted) => {
					setRoom(wanted);
					setFront({ at: "open" });
				}}
				onSignedOut={() => setFront({ at: "sign in" })}
			/>
		);
	}

	return (
		<PreJoin
			room={room}
			onRoomChange={setRoom}
			onJoin={onJoin}
			// Somebody who arrived on a link has no passphrase and was not meant
			// to need one. Showing the field would be showing them a question
			// they cannot answer, next to a name they did choose.
			guest={front.at === "invited"}
		/>
	);
}
