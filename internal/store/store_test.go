package store

import (
	"path/filepath"
	"testing"
)

func open(t *testing.T) *Store {
	t.Helper()

	st, err := Open(filepath.Join(t.TempDir(), "meet.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	return st
}

func TestAFirstJoinCreatesTheTally(t *testing.T) {
	room, err := open(t).TouchRoom("standup")
	if err != nil {
		t.Fatalf("TouchRoom: %v", err)
	}

	if room.Joins != 1 {
		t.Errorf("joins = %d, want 1", room.Joins)
	}
	if !room.Created.Equal(room.Seen) {
		t.Error("the first join should create and see at the same moment")
	}
}

func TestJoinsAccumulateAgainstOneName(t *testing.T) {
	st := open(t)

	first, err := st.TouchRoom("standup")
	if err != nil {
		t.Fatalf("TouchRoom: %v", err)
	}

	second, err := st.TouchRoom("standup")
	if err != nil {
		t.Fatalf("TouchRoom: %v", err)
	}

	if second.Joins != 2 {
		t.Errorf("joins = %d, want 2", second.Joins)
	}
	if !second.Created.Equal(first.Created) {
		t.Error("the creation time belongs to the name, not to the visit")
	}
}

func TestRoomsComeBackMostRecentFirst(t *testing.T) {
	st := open(t)

	if _, err := st.TouchRoom("older"); err != nil {
		t.Fatalf("TouchRoom: %v", err)
	}
	if _, err := st.TouchRoom("newer"); err != nil {
		t.Fatalf("TouchRoom: %v", err)
	}

	rooms, err := st.Rooms()
	if err != nil {
		t.Fatalf("Rooms: %v", err)
	}

	if len(rooms) != 2 {
		t.Fatalf("listed %d rooms, want 2", len(rooms))
	}
	if rooms[0].Name != "newer" {
		t.Errorf("first room is %q, want newer", rooms[0].Name)
	}
}

// The bucket is created by the first write, so a store nothing has been written
// to lists nothing rather than failing.
func TestAnUntouchedStoreListsNothing(t *testing.T) {
	rooms, err := open(t).Rooms()
	if err != nil {
		t.Fatalf("Rooms: %v", err)
	}

	if len(rooms) != 0 {
		t.Errorf("listed %d rooms, want none", len(rooms))
	}
}
