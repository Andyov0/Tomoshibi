import { type Me, inviteToken, invited, me as whoAmI } from "@/live/account";
import { leftRoom, wasIn } from "@/live/api";
import { deployment, join as requestJoin } from "@/live/api";
import { generateRoomName, normaliseRoomName, validRoomName } from "@/live/names";
import { connect, create } from "@/live/room";
import { useT } from "@/hooks/useT";
import { joinFailed } from "@/live/notices";
import { Lobby, SignIn } from "@/routes/Lobby";
import { type Choices, PreJoin, remembered, rememberedName } from "@/routes/PreJoin";
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
/**
 * Which machine was chosen last, so a reload does not silently move the call.
 *
 * In session storage rather than local: it is about this tab and this meeting,
 * and a browser that remembered it for a month would send somebody to a relay
 * they picked once, in another country, for a different call.
 */
const RELAY_KEY = "meet-live.relay";

function lastRelay(): string {
	return sessionStorage.getItem(RELAY_KEY) ?? "";
}

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

				// And an invite that is no good is still an invite, which is to
				// say it is still somebody who was sent here on purpose and who
				// arrives to find the sign-in page of a deployment they have no
				// account on. They were not told why, so the reading available to
				// them is that the link was mistyped or that this is the wrong
				// site — neither of which is true, and both of which end with them
				// asking the person who sent it.
				//
				// Three sentences rather than one, because they are three
				// different next moves: one asks for another link, one says the
				// meeting is over and no link will help, and one says somebody
				// took this link back.
				if (invitation?.error) {
					joinFailed(
						invitation.error === "invite_expired" || invitation.error === "meeting_over"
							? t("That meeting has ended.")
							: invitation.error === "invite_spent"
								? t("That invitation has already been used.")
								: t("That invitation is no longer good. Ask for another."),
					);
				}

				// A deployment anybody may open a room on has no lobby, so the
				// bare address means a new meeting and one is made. Made here
				// rather than on load, which is what used to put a generated name
				// in the address bar of a page that had not decided to be a room
				// yet — somebody signing in read their own URL and found a room
				// they had not asked for.
				// A reload while in a call must not lose the call.
				//
				// The address has said which room this is all along — it is what
				// somebody copies to invite people — and after a reload it was
				// being ignored: the lobby appeared, the room in the address bar
				// was not the room on the screen, and getting back in meant typing
				// a name that was already there. What lands instead is the screen
				// one press from rejoining, rather than a rejoin nobody asked for:
				// a refresh should not put somebody back on a live microphone.
				// Back into the call this tab was in, whoever they are.
				//
				// The guard is that this tab was in this room, not that somebody
				// is signed in. Signed in was the wrong test twice over: it walked
				// somebody who had merely pasted a room link straight into the
				// call without a look at their own camera, and it left everybody
				// who arrived on an invitation — who has no account by design —
				// pressing Join again after every refresh.
				if (initialRoom() && wasIn() === initialRoom()) {
					setFront(
						account
							? { at: "ready", me: account, relay: lastRelay() }
							: { at: "invited", room: initialRoom() },
					);

					void onJoin({
						name: account?.name ?? rememberedName(),
						passphrase: "",
						relay: lastRelay(),
						...remembered(),
					});

					return;
				}

				if (account && initialRoom()) {
					// Back into the call rather than to the screen in front of it.
					//
					// The first attempt landed on the device screen, on the
					// reasoning that a refresh should not put somebody back on a
					// live microphone. That is the wrong way round: they were
					// already on it a second ago, and the surprising thing is not
					// the microphone carrying on — it is a call that stops because
					// a page was reloaded. Every other application on the machine
					// survives a refresh, and this one made you press a button to
					// get back into a conversation you never left.
					//
					// With the devices exactly as they were, so nothing is turned
					// on that was off.
					setFront({ at: "ready", me: account, relay: lastRelay() });

					void onJoin({
						name: account.name,
						passphrase: "",
						relay: lastRelay(),
						...remembered(),
					});

					return;
				}

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

		// Forgotten, or leaving and then reloading would be rejoining — which is
		// the one case where walking somebody back into a call is exactly wrong.
		leftRoom();

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
			// page for a room they have just left. The address goes with them,
			// or the next reload would land on that same page again.
			if (was.at === "ready") {
				window.history.replaceState(null, "", window.location.pathname);
				return { at: "lobby", me: was.me };
			}

			return was;
		});
	}, []);

	// Why the call ended, when it did not end because somebody pressed leave.
	//
	// Three endings, and they are not the same thing: a room that was closed
	// ended for everybody, being removed happened to them alone, and a
	// connection that failed happened to nobody on purpose. Each one ends the
	// call — a room somebody cannot reach is not a room they are in — and each
	// one says which it was, because from the outside all three are a call that
	// simply stopped, and the reading somebody lands on then is that it broke.
	useEffect(() => {
		if (!live) return;

		/*
		 * A room being moved, said before it happens.
		 *
		 * The media server disconnects everybody the same way whether a meeting
		 * is over or is being put up on another machine, and the two want
		 * opposite answers. So the server says which, and this remembers it for
		 * the two seconds between the message and the disconnection.
		 *
		 * A flag rather than state: nothing on screen depends on it, and a
		 * re-render between the warning and the disconnection would be a chance
		 * for the two to disagree.
		 */
		const moving = { soon: false };

		const told = (_payload: Uint8Array, _who: unknown, _kind: unknown, topic?: string) => {
			if (topic === "moving") moving.soon = true;
		};

		live.on(RoomEvent.DataReceived, told);

		const ended = (reason?: number) => {
			// Moved rather than ended: straight back in, to the machine the room
			// has been put on. The address still names the room and this tab is
			// still the tab that was in it, so the ordinary rejoin does the rest.
			if (moving.soon && reason === DISCONNECT_ROOM_CLOSED) {
				setLive(undefined);
				current.current = undefined;

				void onJoin({
					name: front.at === "lobby" || front.at === "ready" ? front.me.name : rememberedName(),
					passphrase: "",
					relay: "",
					...remembered(),
				});

				return;
			}

			// The room is gone for this person either way, so the call goes with
			// it. Saying so and leaving them sitting in it was the old behaviour
			// and it read as the notice being wrong: the tiles were still there,
			// the controls still worked, and nothing they pressed did anything.
			if (reason === DISCONNECT_ROOM_CLOSED) {
				joinFailed(t("The host closed this room."));
				onLeave();
				return;
			}

			if (reason === DISCONNECT_REMOVED) {
				joinFailed(t("You were removed from this room."));
				onLeave();
				return;
			}

			// Anything else is the connection failing, and by the time this fires
			// the client has already retried and given up — RoomEvent.Disconnected
			// is the end of that, not the start.
			//
			// The call ends, but this is not a departure. onLeave is not called,
			// because it forgets the room, and forgetting it here would mean a
			// reload after a drop landed on the front page rather than walking
			// back in. Front is left where it was too, which puts them on the
			// device screen for the room they were just in, with its Join button:
			// one press back, devices already chosen, and nothing automatic that
			// could loop against a relay that is genuinely down.
			//
			// Before this, a drop left the room on screen with a pill in the
			// corner reading "Connecting…" forever. On a deployment where the
			// path to the media server is the thing most likely to fail, that was
			// the most common ending a call had, and it was the one that looked
			// like the software was broken.
			joinFailed(t("The connection to this room was lost."));
			void current.current?.disconnect();
			current.current = undefined;
			setLive(undefined);
		};

		live.on(RoomEvent.Disconnected, ended);

		return () => {
			live.off(RoomEvent.Disconnected, ended);
			live.off(RoomEvent.DataReceived, told);
		};
	}, [live, t, onLeave, onJoin, front]);


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
					sessionStorage.setItem(RELAY_KEY, relay);
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
			onBack={
				front.at === "ready"
					? () => {
							// The address goes back with them, or a reload would land
							// on this screen again for a meeting they walked away
							// from.
							window.history.replaceState(null, "", window.location.pathname);
							setFront({ at: "lobby", me: front.me });
						}
					: undefined
			}
		/>,
	);
}
