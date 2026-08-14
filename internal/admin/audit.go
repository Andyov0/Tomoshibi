package admin

import (
	"log/slog"
	"sync"
	"time"
)

// How many entries are kept to show on the page.
//
// A few hundred, held in memory. This is the tail of the log rather than the
// log: every entry also goes to the process log, which is where anybody asking
// a serious question about last Tuesday should be looking. What this holds is
// the answer to "what just happened", which is the question somebody standing
// at the page actually has.
const kept = 500

// An Entry is one thing an administrator did.
type Entry struct {
	At time.Time `json:"at"`
	// Who did it, by the signature that authorised them. A name can be
	// changed in a configuration file; the signature is what was proved.
	Trip string `json:"trip"`
	Name string `json:"name,omitempty"`
	// What they did, and to what.
	Action string `json:"action"`
	Room   string `json:"room,omitempty"`
	Target string `json:"target,omitempty"`
	// Whether it worked. A refusal is worth as much as a success here: a run
	// of them is the only sign anybody has that somebody is trying doors.
	Failed bool   `json:"failed,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// Log is the recent history of the management pages.
type Log struct {
	mu      sync.Mutex
	entries []Entry
}

func NewLog() *Log {
	return &Log{entries: make([]Entry, 0, kept)}
}

// Record notes something, both here and in the process log.
//
// Both, because the two are read at different times by different people. The
// page answers what happened a moment ago; the process log survives a restart
// and can be shipped somewhere that an attacker with this server cannot reach.
func (l *Log) Record(entry Entry) {
	entry.At = time.Now()

	attrs := []any{"action", entry.Action, "trip", entry.Trip}
	if entry.Name != "" {
		attrs = append(attrs, "name", entry.Name)
	}
	if entry.Room != "" {
		attrs = append(attrs, "room", entry.Room)
	}
	if entry.Target != "" {
		attrs = append(attrs, "target", entry.Target)
	}

	if entry.Failed {
		attrs = append(attrs, "reason", entry.Reason)
		slog.Warn("an administrative action was refused", attrs...)
	} else {
		slog.Info("an administrative action was taken", attrs...)
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	l.entries = append(l.entries, entry)
	if len(l.entries) > kept {
		// Copied down rather than resliced, so the underlying array does not
		// hold the entries that were dropped.
		l.entries = append(l.entries[:0], l.entries[len(l.entries)-kept:]...)
	}
}

// Recent returns what is held, newest first.
func (l *Log) Recent() []Entry {
	l.mu.Lock()
	defer l.mu.Unlock()

	out := make([]Entry, len(l.entries))
	for i, entry := range l.entries {
		out[len(l.entries)-1-i] = entry
	}

	return out
}
