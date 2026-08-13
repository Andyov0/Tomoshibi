import type { ChatMessage, Participant, Room } from "livekit-client";

/** One thing somebody said. */
export interface Said {
	id: string;
	/** Who said it, as the identity their token was signed with. */
	from: string;
	/** What they are called, resolved when it arrived. */
	name: string;
	body: string;
	at: number;
	mine: boolean;
}

/**
 * How long a message stays on somebody's picture.
 *
 * Longer than a notice, because "Sable joined" is read at a glance and a
 * sentence is not. A message that disappears before it has been read is worse
 * than one that was never shown.
 */
export const SAID_FOR = 6000;

/** Send, using the media server's own chat rather than a protocol of our own. */
export function say(room: Room, body: string): Promise<ChatMessage> {
	return room.localParticipant.sendChatMessage(body.trim());
}

/** Turn an arriving message into something the interface can hold. */
export function received(
	message: ChatMessage,
	from: Participant | undefined,
	localIdentity: string,
): Said {
	const identity = from?.identity ?? localIdentity;

	return {
		id: message.id,
		from: identity,
		name: from?.name || identity,
		body: message.message,
		at: message.timestamp,
		mine: identity === localIdentity,
	};
}
