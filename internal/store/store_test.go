package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"tomoshibi/internal/room"

	bolt "go.etcd.io/bbolt"
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

/*
 * Ageing names out, and the two ways it could quietly do harm.
 *
 * A name is written down the first time somebody joins it and nothing ever took
 * one away, so the file grew for as long as anybody asked for names — bounded in
 * how fast by the rate limiter and in how many by nothing. Measured at four
 * hundred bytes apiece, which is the part that makes it worth a sweep rather
 * than a note in a README.
 *
 * The harm is that under a policy where a missing record is a closed door, every
 * one of these deletions is somebody being turned out of a room. So what these
 * check is not that the sweep works but that it is conservative in the two
 * places it could be reckless: a record whose age cannot be read, and a batch
 * that has to end somewhere.
 */

// aged writes a name whose last join was the given while ago.
func aged(t *testing.T, st *Store, name string, ago time.Duration) {
	t.Helper()

	if _, err := st.OpenRoom(name, true); err != nil {
		t.Fatalf("OpenRoom: %v", err)
	}

	err := st.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)

		var tally Room
		if err := json.Unmarshal(bucket.Get([]byte(name)), &tally); err != nil {
			return err
		}

		tally.Seen = time.Now().UTC().Add(-ago)

		encoded, err := json.Marshal(tally)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(name), encoded)
	})
	if err != nil {
		t.Fatalf("age %q: %v", name, err)
	}
}

func names(t *testing.T, st *Store) []string {
	t.Helper()

	found, err := st.Rooms()
	if err != nil {
		t.Fatalf("Rooms: %v", err)
	}

	var out []string
	for _, one := range found {
		out = append(out, one.Name)
	}
	sort.Strings(out)

	return out
}

func TestOnlyNamesNobodyHasJoinedSinceGoAway(t *testing.T) {
	st := open(t)

	aged(t, st, "ancient", 90*24*time.Hour)
	aged(t, st, "weekly", 3*24*time.Hour)

	gone, err := st.Forget(time.Now().Add(-30*24*time.Hour), 100)
	if err != nil {
		t.Fatalf("Forget: %v", err)
	}
	if gone != 1 {
		t.Fatalf("forgot %d, want 1", gone)
	}

	if got := names(t, st); len(got) != 1 || got[0] != "weekly" {
		t.Errorf("left %v, want only weekly", got)
	}
}

// The whole point of the sweep, said as a property rather than a count: a room
// somebody keeps using is never aged out, however long the deployment runs.
func TestARoomInUseIsNeverForgotten(t *testing.T) {
	st := open(t)

	aged(t, st, "standup", 90*24*time.Hour)

	// Somebody joins it again, which is what a room in use looks like.
	if _, err := st.OpenRoom("standup", false); err != nil {
		t.Fatalf("OpenRoom: %v", err)
	}

	gone, err := st.Forget(time.Now().Add(-30*24*time.Hour), 100)
	if err != nil {
		t.Fatalf("Forget: %v", err)
	}
	if gone != 0 {
		t.Errorf("forgot %d rooms, want none", gone)
	}
}

/*
 * bbolt admits one writer and a join is a write, so a sweep that cleared a
 * neglected bucket in one transaction would hold that writer for the whole of
 * it and everybody joining a call would wait behind it. The bound is what makes
 * that impossible; the caller comes back for the rest.
 */
func TestASweepStopsWhereItWasToldTo(t *testing.T) {
	st := open(t)

	for i := 0; i < 25; i++ {
		aged(t, st, fmt.Sprintf("old-%02d", i), 90*24*time.Hour)
	}

	since := time.Now().Add(-30 * 24 * time.Hour)

	gone, err := st.Forget(since, 10)
	if err != nil {
		t.Fatalf("Forget: %v", err)
	}
	if gone != 10 {
		t.Fatalf("forgot %d in one pass, want the 10 it was allowed", gone)
	}
	if left := len(names(t, st)); left != 15 {
		t.Fatalf("%d names left, want 15", left)
	}

	// And the caller coming back finishes it.
	total := gone
	for {
		gone, err = st.Forget(since, 10)
		if err != nil {
			t.Fatalf("Forget: %v", err)
		}
		total += gone
		if gone < 10 {
			break
		}
	}

	if total != 25 {
		t.Errorf("forgot %d altogether, want 25", total)
	}
	if left := names(t, st); len(left) != 0 {
		t.Errorf("left %v", left)
	}
}

/*
 * A record this build cannot read has an age nobody knows. Under a policy where
 * a missing record is a closed door, deleting on an unknown age is the wrong way
 * to be wrong — so it stays, and stays readable to the one thing that still
 * understands it: the check for whether the name has been used at all.
 */
func TestARecordThatCannotBeReadIsLeftAlone(t *testing.T) {
	st := open(t)

	err := st.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(rooms)
		if err != nil {
			return err
		}

		return bucket.Put([]byte("from-a-later-build"), []byte("{ not a room"))
	})
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	gone, err := st.Forget(time.Now(), 100)
	if err != nil {
		t.Fatalf("Forget: %v", err)
	}
	if gone != 0 {
		t.Fatalf("forgot %d, want none", gone)
	}

	// Still a name that has been used, which is what keeps its room open.
	if _, err := st.OpenRoom("from-a-later-build", false); err != nil {
		t.Errorf("a room whose record could not be read was closed: %v", err)
	}
}

func TestForgettingNothingIsNotAnError(t *testing.T) {
	st := open(t)

	gone, err := st.Forget(time.Now(), 100)
	if err != nil {
		t.Fatalf("Forget on an untouched store: %v", err)
	}
	if gone != 0 {
		t.Errorf("forgot %d from an untouched store", gone)
	}
}

/*
A note about where a room is has to stop being believed.

It is written after a join so the next person lands where the meeting already
is, which saves them a measurement and is what lets somebody into a relay
reserved for the administrator who invited them. Left to itself it never
expired, and that turns a hint into a permanent binding: every room returns to
whichever relay it first landed on, for good, and choosing a server stops
meaning anything the second time a name is used.

There is no cheap way to ask whether anybody is still in the room — the media
server knows and asking it is a request to every relay on every join — so the
note ages out instead. Being wrong either way is survivable: too eager and
somebody is forwarded by the media server with only a measurement wasted, too
patient and a meeting that ended hours ago sends the next one back to a machine
it need not use. Lasting forever is the only outcome that is not.
*/

func TestWhereARoomIsHeldIsForgottenOnceItGoesQuiet(t *testing.T) {
	st := open(t)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	if err := st.HoldRoom("standup", "shanghai"); err != nil {
		t.Fatal(err)
	}

	if got, _ := st.HeldOn("standup"); got != "shanghai" {
		t.Fatalf("a room joined a moment ago is held on %q, wanted shanghai", got)
	}

	// Aged past the window by hand, because waiting two hours is not a test.
	if err := st.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)

		var tally Room
		if err := json.Unmarshal(bucket.Get([]byte("standup")), &tally); err != nil {
			return err
		}

		tally.HeldAt = time.Now().Add(-heldFor - time.Minute)

		encoded, err := json.Marshal(tally)
		if err != nil {
			return err
		}

		return bucket.Put([]byte("standup"), encoded)
	}); err != nil {
		t.Fatal(err)
	}

	if got, _ := st.HeldOn("standup"); got != "" {
		t.Errorf("a room nobody has joined for hours is still held on %q; choosing a "+
			"server would never mean anything again", got)
	}
}
