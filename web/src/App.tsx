import { type Me, inviteToken, invited, me as whoAmI } from "@/live/account";
import { deployment, join as requestJoin } from "@/live/api";
import { generateRoomName, normaliseRoomName, validRoomName } from "@/live/names";
import { connect, create } from "@/live/room";
import { useT } from "@/hooks/useT";
import { joinFailed } from "@/live/notices";
import { Lobby, SignIn } from "@/routes/Lobby";
import { type Choices, PreJoin } from "@/routes/PreJoin";
import { Room } from "@/routes/Room";
import { RoomEvent, type Room as LiveRoom } from "livekit-client";
import type { ReactNode } from "react";

/*
 * Why a call ended, as the media server numbers it.
 *
 * Written out rather than imported from the protocol package, which is a
 * transitive dependency of the client rather than one this application declares
 * — importing from it would make the manifest wrong in the direction the
 * dependency test cannot see. The numbers are wire format and do not move; read
 * out of `@livekit/protocol`'s own generated enum, where PARTICIPANT_REMOVED is
 * 4 and ROOM_DELETED is 5.
 */
const DISCONNECT_REMOVED = 4;
const DISCONNECT_ROOM_CLOSED = 5;
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
	| { at: "ready"; me: Me; relay: string }
	| { at: "invited"; room: string }
	| { at: "done" };

export function App() {
	const t = useT();
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

		// A guest has nowhere to be sent back to.
		//
		// Everybody else came from a lobby or from a page they can use again, and
		// returning them there is right. Somebody who arrived on a link has no
		// account, and the screens behind this one are a sign-in they cannot
		// satisfy and a room they were not invited to twice — offering either is
		// offering a door that does not open. So the call ends and the page says
		// so, and there is nothing else on it, because there is nothing else they
		// can usefully do here.
		setFront((was) => {
			if (was.at === "invited") return { at: "done" };

			// And back to the lobby rather than to the device screen, which is a
			// page for a room they have just left.
			if (was.at === "ready") return { at: "lobby", me: was.me };

			return was;
		});
	}, []);

	// Why the call ended, when it did not end because somebody pressed leave.
	//
	// Two of the media server's reasons mean something a person needs told, and
	// they are not the same thing: a room that was closed ended for everybody,
	// and being removed happened to them alone. Left unsaid, both look identical
	// from the outside — the call simply stops and the page goes back to the
	// front — and the reading somebody lands on is that it broke.
	useEffect(() => {
		if (!live) return;

		const ended = (reason?: number) => {
			if (reason === DISCONNECT_ROOM_CLOSED) {
				joinFailed(t("The host closed this room."));
			} else if (reason === DISCONNECT_REMOVED) {
				joinFailed(t("You were removed from this room."));
			}
		};

		live.on(RoomEvent.Disconnected, ended);

		return () => {
			live.off(RoomEvent.Disconnected, ended);
		};
	}, [live, t, onLeave]);


	/*
	 * Every screen arrives, and none of them simply appears.
	 *
	 * Sign-in to lobby to devices to call is four steps, each one a decision
	 * somebody has just made, and a screen replaced between two frames reads as
	 * the page having reloaded rather than as having moved. Keyed on which screen
	 * it is, so React discards the old tree and mounts the new one — without the
	 * key it reuses the node, the animation never restarts, and every step after
	 * the first is exactly as bare as it was before.
	 */
	const page = (at: string, screen: ReactNode) => (
		<div key={at} className="animate-page h-full">
			{screen}
		</div>
	);

	if (live) {
		return page("call", <Room room={live} relay={holding} carrying={carrying} onLeave={onLeave} />);
	}

	// Nothing rather than a spinner. The two requests behind this take one round
	// trip on a warm connection, and a spinner shown for that long is a flash
	// somebody notices without being able to read.
	if (front.at === "asking") return <div className="min-h-full bg-bg" />;

	if (front.at === "done") {
		return page(
			"done",
			<main className="grid min-h-full place-items-center bg-bg p-6">
				<p className="animate-rise text-fg-muted text-sm">{t("You have left the room.")}</p>
			</main>,
		);
	}

	if (front.at === "sign in") {
		return page(
			"sign in",
			<SignIn onSignedIn={(account) => setFront({ at: "lobby", me: account })} />,
		);
	}

	if (front.at === "lobby") {
		return page(
			"lobby",
			<Lobby
				me={front.me}
				onOpen={(wanted, relay) => {
					setRoom(wanted);
					setFront({ at: "ready", me: front.me, relay });
				}}
				onSignedOut={() => setFront({ at: "sign in" })}
			/>,
		);
	}

	return page(
		"devices",
		<PreJoin
			room={room}
			onRoomChange={setRoom}
			onJoin={onJoin}
			// Somebody who arrived on a link has no passphrase and was not meant
			// to need one. Showing the field would be showing them a question
			// they cannot answer, next to a name they did choose.
			guest={front.at === "invited"}
			as={front.at === "ready" ? { name: front.me.name, relay: front.relay } : undefined}
		/>,
	);
}
