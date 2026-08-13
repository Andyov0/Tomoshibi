import { SAID_FOR, type Said, received } from "@/live/chat";
import type { ChatMessage, Participant, Room } from "livekit-client";
import { RoomEvent } from "livekit-client";
import { useCallback, useEffect, useMemo, useState } from "react";

export interface Chat {
	/** Everything said this call, oldest first. */
	all: Said[];
	/** What is still showing on somebody's picture, by identity. */
	showing: Map<string, Said[]>;
	/** Something arrived while the panel was closed. */
	unread: boolean;
	/** Called when the panel opens, which is what clears the mark. */
	markRead: () => void;
}

/**
 * Collect what is said during a call.
 *
 * Nothing is persisted. Messages live as long as this component does, which is
 * as long as the call, and the room they belong to stops existing at the same
 * moment for the same reason.
 */
export function useChat(room: Room | undefined, open: boolean): Chat {
	const [all, setAll] = useState<Said[]>([]);
	const [recent, setRecent] = useState<Said[]>([]);
	const [unread, setUnread] = useState(false);

	useEffect(() => {
		if (!room) return;

		const onMessage = (message: ChatMessage, from?: Participant) => {
			const said = received(message, from, room.localParticipant.identity);

			setAll((held) => [...held, said]);
			setRecent((held) => [...held, said]);

			// Our own messages are never unread, and neither is anything that
			// arrives while the panel is open.
			if (!said.mine && !open) setUnread(true);

			// Each message clears itself rather than a timer sweeping the list,
			// so one that arrived late is not cut short by an earlier one.
			setTimeout(() => {
				setRecent((held) => held.filter((other) => other.id !== said.id));
			}, SAID_FOR);
		};

		room.on(RoomEvent.ChatMessage, onMessage);
		return () => {
			room.off(RoomEvent.ChatMessage, onMessage);
		};
	}, [room, open]);

	// Nothing floats over a picture while the panel is open: the same sentence
	// in two places makes the reader decide twice whether they have seen it.
	const showing = useMemo(() => {
		const by = new Map<string, Said[]>();
		if (open) return by;

		for (const said of recent) {
			const held = by.get(said.from);
			if (held) held.push(said);
			else by.set(said.from, [said]);
		}

		return by;
	}, [recent, open]);

	const markRead = useCallback(() => setUnread(false), []);

	return { all, showing, unread, markRead };
}
