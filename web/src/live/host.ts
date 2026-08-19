import type { Participant, Room } from "livekit-client";
import { RoomEvent, Track } from "livekit-client";
import { useCallback, useEffect, useState } from "react";
import { roster, tokenFor } from "./room";

/*
What the person running a meeting can do about it.

The powers are ordinary and the authorisation is the interesting part. There are
no sessions for people in a call — a join is stateless and deliberately so — and
sending a passphrase back with every mute would put a credential on the wire for
each press. The token this server signed is the answer: it names one room and one
identity, it cannot be edited, and the server that verifies it is the server that
signed it. So it goes in an Authorization header and nothing here has to hold
anything secret of its own.

None of this is deployment moderation, which lives behind the management pages
and can close any room on any relay. This is the smaller thing every meeting
needs: quiet a microphone somebody left open, remove somebody who will not leave,
and hand the room on when you go.
*/

/** What this browser may do in this room. */
export interface Standing {
	/** Whoever the room answers to, as a mark. Empty where it answers to nobody. */
	host: string;
	/** Whether the person reading is that, one way or another. */
	yours: boolean;
	/** And whether by being an administrator, which is worth saying differently. */
	admin: boolean;
}

/**
 * The token this call was authorised with.
 *
 * Kept where the join put it. Not in local storage: a token is a credential for
 * one room for a few hours, and the tab that holds it is exactly as long as it
 * should outlive.
 */
function bearer(room: Room): string {
	// Ours, kept at the join. The SDK has its own copy and it is a private field:
	// private is a compiler's opinion rather than a runtime guarantee, so reading
	// it would work until a minified build renamed it, at which point every host
	// control would stop authorising with nothing anywhere saying why.
	return tokenFor(room);
}

async function ask(room: Room, path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`/api/rooms/${encodeURIComponent(room.name)}${path}`, {
		...init,
		headers: {
			...(init.headers ?? {}),
			"content-type": "application/json",
			Authorization: `Bearer ${bearer(room)}`,
		},
	});
}

/** Whether this browser runs this room, asked again whenever it might change. */
export function useStanding(room: Room): Standing {
	const [standing, setStanding] = useState<Standing>({ host: "", yours: false, admin: false });

	const refresh = useCallback(() => {
		void ask(room, "/host", { method: "GET" })
			.then((response) => (response.ok ? (response.json() as Promise<Standing>) : undefined))
			.then((said) => said && setStanding(said))
			.catch(() => {});
	}, [room]);

	useEffect(() => {
		refresh();

		// A handover is written on the server and nothing pushes it here, so this
		// asks again on the events that could mean it happened: somebody leaving
		// is the ordinary reason a room changes hands.
		const events = [RoomEvent.ParticipantDisconnected, RoomEvent.ConnectionStateChanged];

		for (const event of events) room.on(event, refresh);

		return () => {
			for (const event of events) room.off(event, refresh);
		};
	}, [room, refresh]);

	return { ...standing, refresh } as Standing & { refresh: () => void };
}

/** Quieten somebody's microphone, from the server rather than by asking them. */
export async function silence(room: Room, person: Participant): Promise<void> {
	const microphone = person.getTrackPublication(Track.Source.Microphone);

	if (!microphone) return;

	const response = await ask(room, "/mute", {
		method: "POST",
		body: JSON.stringify({ identity: person.identity, track: microphone.trackSid }),
	});

	if (!response.ok) throw new Error("mute_failed");
}

/** Remove somebody from the room. */
export async function turnOut(room: Room, person: Participant): Promise<void> {
	const response = await ask(
		room,
		`/people/${encodeURIComponent(person.identity)}`,
		{ method: "DELETE" },
	);

	if (!response.ok) throw new Error("remove_failed");
}

/**
 * End the meeting for everybody.
 *
 * The one control that is not about a person. A host who leaves a room they
 * cannot close leaves a meeting that goes on without them, under a name they
 * will use again next week — and because a room here is a name, whoever stayed
 * is sitting in next week's meeting.
 */
export async function dissolve(room: Room): Promise<void> {
	const response = await ask(room, "/close", { method: "POST" });

	if (!response.ok) throw new Error("close_failed");
}

/**
 * Put the meeting on another machine, without ending it.
 *
 * Everybody is told the room is moving and then it is taken down; their clients
 * hear the first, treat the second as a move rather than an ending, and come
 * straight back to the machine chosen here.
 *
 * A relay reserved for administrators is refused by the server, not merely left
 * off the list offered here. A list is a courtesy and a check is a rule.
 */
export async function moveRoom(room: Room, relay: string): Promise<void> {
	const response = await ask(room, "/relay", {
		method: "PUT",
		body: JSON.stringify({ relay }),
	});

	if (!response.ok) throw new Error("move_failed");
}

/** Hand the room to somebody else. */
export async function handOver(room: Room, person: Participant): Promise<void> {
	const response = await ask(room, "/host", {
		method: "POST",
		body: JSON.stringify({ to: person.identity }),
	});

	if (!response.ok) throw new Error("handover_failed");
}

/**
 * A link that lets one person in, once, without a passphrase.
 *
 * Returned as a whole address rather than a token, because what somebody does
 * next is paste it. Built from the address bar rather than assembled from parts,
 * which is right until the first deployment behind a path or a different port.
 */
export async function invite(room: Room): Promise<string> {
	const response = await ask(room, "/invites", { method: "POST" });

	if (!response.ok) throw new Error("invite_failed");

	const made = (await response.json()) as { token: string };

	const url = new URL(window.location.href);
	url.search = `?invite=${encodeURIComponent(made.token)}`;
	url.hash = `#/${room.name}`;

	return url.toString();
}

/**
 * Stop every link to this room working, without ending the meeting.
 *
 * The other way a link dies is the room being closed, which is a far bigger
 * thing than anybody wants to do about a link pasted into the wrong window.
 */
export async function revoke(room: Room): Promise<void> {
	const response = await ask(room, "/invites", { method: "DELETE" });

	if (!response.ok) throw new Error("revoke_failed");
}

/** Everybody else in the call, for a list that acts on them. */
export function useOthers(room: Room): Participant[] {
	const [others, setOthers] = useState<Participant[]>([]);

	useEffect(() => {
		const gather = () =>
			setOthers(roster(room).filter((one) => one.identity !== room.localParticipant.identity));

		gather();

		const events = [
			RoomEvent.ParticipantConnected,
			RoomEvent.ParticipantDisconnected,
			RoomEvent.TrackMuted,
			RoomEvent.TrackUnmuted,
			RoomEvent.TrackPublished,
			RoomEvent.TrackUnpublished,
		];

		for (const event of events) room.on(event, gather);

		return () => {
			for (const event of events) room.off(event, gather);
		};
	}, [room]);

	return others;
}
