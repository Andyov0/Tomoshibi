import { KEEP, SAID_FOR, type Said, received } from "@/live/chat";
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
	/** Send, resolving when the media server has it. */
	send: (body: string) => Promise<unknown>;
	/** A message is in flight. */
	sending: boolean;
	/** Called when the panel opens, which is what clears the mark. */
	markRead: () => void;
}

/**
 * Collect what is said during a call.
 *
 * Subscribes to the room's own chat event rather than going through the
 * library's `useChat`. That hook takes a room and looked like the right answer,
 * but it hands back an empty list unless the tree is wrapped in the provider it
 * expects, and this application deliberately owns its room object instead. The
 * event underneath it is two lines; the provider is not worth adopting for
 * them.
 *
 * Nothing is persisted. Messages live as long as this component does, which is
 * as long as the call, and the room they belong to stops existing at the same
 * moment for the same reason.
 */
export function useChat(room: Room | undefined, open: boolean): Chat {
	const [all, setAll] = useState<Said[]>([]);
	const [recent, setRecent] = useState<Said[]>([]);
	const [unread, setUnread] = useState(false);
	const [sending, setSending] = useState(false);

	useEffect(() => {
		if (!room) return;

		const onMessage = (message: ChatMessage, from?: Participant) => {
			const said = received(message, from, room.localParticipant.identity);

			// Trimmed as it grows rather than swept later: a long call otherwise
			// keeps every message mounted in the panel, and five hundred is more
			// than anybody scrolls back through.
			setAll((held) => {
				const next = [...held, said];
				return next.length > KEEP ? next.slice(-KEEP) : next;
			});

			// Our own words are not news to us. Floating them over our own
			// picture covers a face to repeat something we just typed.
			if (said.mine) return;

			setRecent((held) => [...held, said]);
			if (!open) setUnread(true);

			// Each message clears itself rather than a sweep over the list, so
			// one that arrived late is not cut short by an earlier one.
			setTimeout(() => {
				setRecent((held) => held.filter((other) => other.id !== said.id));
			}, SAID_FOR);
		};

		room.on(RoomEvent.ChatMessage, onMessage);
		return () => {
			room.off(RoomEvent.ChatMessage, onMessage);
		};
	}, [room, open]);

	// Nothing floats over a picture while the panel is open: the same sentence in
	// two places makes the reader decide twice whether they have seen it.
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

	const send = useCallback(
		async (body: string) => {
			if (!room) return;

			setSending(true);
			try {
				await room.localParticipant.sendChatMessage(body.trim());
			} finally {
				setSending(false);
			}
		},
		[room],
	);

	const markRead = useCallback(() => setUnread(false), []);

	return { all, showing, unread, send, sending, markRead };
}
