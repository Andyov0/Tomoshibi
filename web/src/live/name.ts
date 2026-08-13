/**
 * Display names, and the signatures that make one hard to wear.
 *
 * Names here are what people call themselves, which means anybody can call
 * themselves anything. A passphrase turns a name into one only its holder can
 * appear under: the server derives a short signature from it and puts that in
 * the identity, which is signed into the token and enforced by the media server.
 * So the signature is not a claim travelling beside the name, it is part of what
 * the participant provably is.
 *
 * The syntax is borrowed from imageboard tripcodes, which is where the idea and
 * most of its users' familiarity come from.
 */

/** A name as typed, split into what is shown and what proves it. */
export interface Named {
	/** Shown to everybody. */
	name: string;
	/** Never shown, never stored anywhere but this tab. */
	passphrase: string;
}

/** How long a signature is, matching what the server derives. */
export const TRIP_LENGTH = 10;

/**
 * Split `Alice#secret` into a name and a passphrase.
 *
 * Only the first separator counts, so a passphrase may contain them: the harder
 * a passphrase is, the better, and rejecting a character would be advice in the
 * wrong direction.
 */
export function parseName(typed: string): Named {
	const separator = typed.indexOf("#");

	if (separator === -1) {
		return { name: typed.trim(), passphrase: "" };
	}

	return {
		name: typed.slice(0, separator).trim(),
		passphrase: typed.slice(separator + 1),
	};
}

/** The mark an identity carries, and where it came from. */
export interface Signature {
	trip: string;
	/**
	 * Derived from a passphrase rather than from nothing.
	 *
	 * The difference between "this is the same person as last time" and "these
	 * two people in this room are not the same person". Both are useful; only
	 * the first is a claim about anybody, and only the first may be drawn as
	 * one.
	 */
	proven: boolean;
}

/**
 * The mark an identity carries.
 *
 * Read from the identity rather than from anything sent alongside it. The
 * identity is the one field about a participant that neither they nor anybody
 * else can change after the token was signed, which is what makes the mark
 * worth anything at all.
 */
export function signatureOf(identity: string): Signature | undefined {
	const kind = identity[0];
	if (kind !== "t" && kind !== "g") return undefined;

	const trip = identity.slice(1, 1 + TRIP_LENGTH);
	if (trip.length !== TRIP_LENGTH || identity[1 + TRIP_LENGTH] !== "-") return undefined;
	if (!/^[a-z2-7]+$/.test(trip)) return undefined;

	return { trip, proven: kind === "t" };
}

/**
 * Whether somebody is wearing a name that another participant has proven.
 *
 * Only ever said about the one who cannot prove it, and only when the collision
 * is with somebody who can. Two people genuinely called Alex is ordinary and
 * worth no comment; somebody unproven appearing under a name that was proven is
 * the one shape impersonation takes, since impersonating a name nobody
 * recognises achieves nothing.
 */
export function impersonating(
	participant: { name: string; identity: string },
	everybody: readonly { name: string; identity: string }[],
): boolean {
	if (signatureOf(participant.identity)?.proven) return false;
	if (!participant.name) return false;

	return everybody.some(
		(other) =>
			other.identity !== participant.identity &&
			other.name === participant.name &&
			signatureOf(other.identity)?.proven === true,
	);
}
