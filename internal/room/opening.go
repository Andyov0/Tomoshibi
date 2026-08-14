package room

// Opening is who may use a name nobody has used before.
//
// The distinction exists only because a room here is a name and nothing else.
// There is no object to create and no membership to join, so opening a room is
// not an operation anybody performs — it is what happens the first time a name
// is spoken, and the only trace of it is a tally written down afterwards. A
// policy about it is therefore a policy about first use, and the one place it
// can be enforced is the one place that tally is written.
//
// Which is also its whole scope. A name already in use is untouched by any of
// this: a meeting in progress can never be interrupted by a policy that only
// ever looks at names nobody has spoken.
type Opening string

const (
	// ByAnyone leaves a name nobody has used free to whoever asks for it. What
	// this server has always done, and what an anonymous meeting link means
	// everywhere it appears.
	ByAnyone Opening = "anyone"

	// ByAdmins refuses one unless the passphrase that came with the request is
	// an administrator's.
	ByAdmins Opening = "admins"
)

// Valid reports whether this is one of the two.
func (o Opening) Valid() bool {
	return o == ByAnyone || o == ByAdmins
}

// InEffect resolves a policy against how many administrators there are to
// satisfy it.
//
// Asking for an administrator where nobody is configured as one is not a policy
// but a locked door with no key: no request could ever satisfy it, and every
// name nobody has used would be refused for as long as the deployment lasts.
// Read as ByAnyone instead, and said out loud at startup — the alternative is a
// server that looks like it is working and turns everybody away.
//
// Anything unrecognised is read the same way, on the same principle the store
// applies to a record it cannot parse: the default is the state a deployment
// that never touched this is in, and nothing here should be able to keep
// somebody out of a meeting by being unreadable.
func (o Opening) InEffect(admins int) Opening {
	if !o.Valid() || (o == ByAdmins && admins == 0) {
		return ByAnyone
	}

	return o
}
