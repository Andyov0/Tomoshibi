package room

/*
Who may walk into a meeting that is already happening.

A room here is a name and nothing else, and for a long time that was the whole
of the door: knowing the name let you in. The invite mechanism was built around
that — an invite exists so that somebody can be let into one call without being
handed the name of every future instance of it — but nothing ever required one.
So a name short enough to guess was a meeting anybody could walk into, and the
people already in it would see somebody arrive with no way to tell how they got
there.

That is a defensible design for a deployment where the names are long and shared
carefully, and an indefensible one for a deployment whose rooms are called
things like 223223. Hence a setting rather than a change.

Separate from Opening, which is about *creating* a name. The two questions look
alike and are not: a deployment may well want anybody with an account to be able
to hold a meeting, and still not want a stranger who guessed the name to be in
it. Answering both with one setting is what made the weaker of the two invisible.
*/

// Joining is who may enter a room that already exists.
type Joining string

const (
	// ByWhoeverKnows lets anybody who has the name in. What protects a meeting
	// is then the name itself, which is the model this deployment had before
	// the setting existed and is still right where names are long and given out
	// like passwords.
	ByWhoeverKnows Joining = "anyone"

	// ByInvitation asks for something the room itself gave out: an invite, an
	// account on this deployment, an administrator's passphrase, or being the
	// person who opened the room.
	//
	// The host is in that list because they must be. A host comes back to their
	// own meeting with the passphrase they opened it with and no invite — they
	// were never sent one — and a rule that locked them out of the room they
	// are running would be worse than the one it replaced.
	ByInvitation Joining = "invited"

	// ByAccount asks for an account and takes nothing else, invites included.
	// For a deployment where everybody who is meant to be in a call has one.
	ByAccount Joining = "accounts"
)

// Valid reports whether this is one of the three.
func (j Joining) Valid() bool {
	return j == ByWhoeverKnows || j == ByInvitation || j == ByAccount
}

// InEffect resolves a policy against whether anybody could satisfy it.
//
// A deployment set to accounts with no accounts is a deployment nobody can join
// — including whoever set it, who is then locked out of the pages that would
// let them set it back. Read as invitation instead, which is the nearest thing
// that leaves a way in, and said out loud at startup.
func (j Joining) InEffect(accounts int) Joining {
	if !j.Valid() {
		return ByWhoeverKnows
	}

	if j == ByAccount && accounts == 0 {
		return ByInvitation
	}

	return j
}
