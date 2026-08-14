package store

import (
	"errors"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"

	"tomoshibi/internal/room"
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
	tally, err := open(t).OpenRoom("standup", true)
	if err != nil {
		t.Fatalf("OpenRoom: %v", err)
	}

	if tally.Joins != 1 {
		t.Errorf("joins = %d, want 1", tally.Joins)
	}
	if !tally.Created.Equal(tally.Seen) {
		t.Error("the first join should create and see at the same moment")
	}
}

func TestJoinsAccumulateAgainstOneName(t *testing.T) {
	st := open(t)

	first, err := st.OpenRoom("standup", true)
	if err != nil {
		t.Fatalf("OpenRoom: %v", err)
	}

	second, err := st.OpenRoom("standup", true)
	if err != nil {
		t.Fatalf("OpenRoom: %v", err)
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

	if _, err := st.OpenRoom("older", true); err != nil {
		t.Fatalf("OpenRoom: %v", err)
	}
	if _, err := st.OpenRoom("newer", true); err != nil {
		t.Fatalf("OpenRoom: %v", err)
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

/*
 * The gate, and the thing it rests on.
 *
 * "Opening a room" is not an operation anybody performs here, so there is no
 * created-at to compare against and no object whose existence could be checked.
 * There is a name, and the only fact about it is whether it has ever been used.
 * Everything below is about that one fact holding still while two people ask
 * about it at once.
 */

func TestAnUnusedNameIsRefusedToSomebodyWhoMayNotOpenOne(t *testing.T) {
	st := open(t)

	if _, err := st.OpenRoom("standup", false); !errors.Is(err, ErrNotOpen) {
		t.Fatalf("OpenRoom refused with %v, want ErrNotOpen", err)
	}

	// And left no trace, so that a refusal is not itself what opens the room
	// for whoever asks next.
	rooms, err := st.Rooms()
	if err != nil {
		t.Fatalf("Rooms: %v", err)
	}
	if len(rooms) != 0 {
		t.Errorf("a refused name was written down anyway: %v", rooms)
	}
}

// The case the whole policy exists to leave alone. Once a name is in use it is
// nobody's to open again, so the question is never asked of it — a meeting in
// progress cannot be interrupted by this.
func TestANameInUseIsOpenToEverybody(t *testing.T) {
	st := open(t)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatalf("OpenRoom: %v", err)
	}

	tally, err := st.OpenRoom("standup", false)
	if err != nil {
		t.Fatalf("somebody was refused a room that was already open: %v", err)
	}
	if tally.Joins != 2 {
		t.Errorf("joins = %d, want 2", tally.Joins)
	}
}

/*
 * Two people arriving at a fresh name in the same instant.
 *
 * The reason the check and the tally are one transaction. Asked separately —
 * read, decide, write — every one of these would find nothing there and the
 * answer would come down to which of them the scheduler ran first. Here exactly
 * one opens the room and the rest are let in behind them, which is what anybody
 * would expect of a link sent to a group who all click it at once.
 */
func TestOnlyOneOfManyArrivalsOpensTheRoom(t *testing.T) {
	st := open(t)

	const arrivals = 64

	var (
		wg      sync.WaitGroup
		opened  atomic.Int64
		refused atomic.Int64
	)

	for i := 0; i < arrivals; i++ {
		// The first is the only one who may open it; everybody else is somebody
		// the policy would turn away from a name nobody had used.
		mayOpen := i == 0

		wg.Add(1)
		go func() {
			defer wg.Done()

			switch _, err := st.OpenRoom("standup", mayOpen); {
			case err == nil:
				opened.Add(1)
			case errors.Is(err, ErrNotOpen):
				refused.Add(1)
			default:
				t.Errorf("OpenRoom: %v", err)
			}
		}()
	}

	wg.Wait()

	// Everybody who arrived after the name was written down is in, and the
	// count of those turned away is however many got there first. What must not
	// happen is nobody getting in, or the tally losing a join it accepted.
	if opened.Load() < 1 {
		t.Fatal("nobody opened the room")
	}
	if opened.Load()+refused.Load() != arrivals {
		t.Fatalf("%d opened and %d refused, out of %d",
			opened.Load(), refused.Load(), arrivals)
	}

	rooms, err := st.Rooms()
	if err != nil {
		t.Fatalf("Rooms: %v", err)
	}
	if len(rooms) != 1 {
		t.Fatalf("listed %d rooms, want 1", len(rooms))
	}

	// The tally is the other half of the same guarantee: a read-modify-write
	// that is not serialised loses increments long before it lets two people
	// open one name.
	if got := rooms[0].Room.Joins; got != uint64(opened.Load()) {
		t.Errorf("joins = %d, want %d", got, opened.Load())
	}
}

func TestAStoreNobodyHasChosenForLeavesRoomsToAnybody(t *testing.T) {
	if opening := open(t).Opening(); opening != room.ByAnyone {
		t.Errorf("opening = %q, want %q", opening, room.ByAnyone)
	}
}

func TestAChoiceOutlivesTheProcessThatMadeIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "meet.db")

	first, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := first.SetOpening(room.ByAdmins); err != nil {
		t.Fatalf("SetOpening: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	second, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { second.Close() })

	if opening := second.Opening(); opening != room.ByAdmins {
		t.Errorf("opening = %q, want %q", opening, room.ByAdmins)
	}
}

func TestNothingThatIsNotAPolicyCanBeStored(t *testing.T) {
	st := open(t)

	if err := st.SetOpening("administrators"); err == nil {
		t.Fatal("SetOpening accepted something that is not a way of opening rooms")
	}
	if opening := st.Opening(); opening != room.ByAnyone {
		t.Errorf("a refused value was stored anyway: %q", opening)
	}
}

/*
 * The configuration file is where this starts and not where it lives.
 *
 * A file read on every boot would be able to undo a choice made from the
 * management pages, silently, on the next restart — and the person who made the
 * choice would have no way to tell, since the pages would go on showing what
 * they set until the process happened to stop.
 */
func TestTheConfiguredValueIsTakenOnlyWhereNothingWasChosen(t *testing.T) {
	st := open(t)

	opening, err := st.AdoptOpening(room.ByAdmins)
	if err != nil {
		t.Fatalf("AdoptOpening: %v", err)
	}
	if opening != room.ByAdmins {
		t.Fatalf("adopted %q on a fresh store, want %q", opening, room.ByAdmins)
	}

	if err := st.SetOpening(room.ByAnyone); err != nil {
		t.Fatalf("SetOpening: %v", err)
	}

	// The restart, with the file still saying what it always said.
	opening, err = st.AdoptOpening(room.ByAdmins)
	if err != nil {
		t.Fatalf("AdoptOpening: %v", err)
	}
	if opening != room.ByAnyone {
		t.Errorf("the file undid a choice made from the management pages: %q", opening)
	}
}
