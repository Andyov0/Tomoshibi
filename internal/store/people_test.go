package store

import (
	"testing"
	"time"
)

/*
The register is a door, and a door that quietly stays open is worse than none.

Blocking somebody is the one thing an operator can do about a person that is not
undone by their rejoining — removing them from a room and closing a room both
are. So what is guarded here is that the block is what the join reads, that it
survives everything else being edited, and that forgetting somebody is not a
silent way of letting them back in without saying so.

The other half is what is not recorded. An anonymous visitor's signature is
drawn from nothing and differs in every tab; writing those down would make this a
list of tabs and would say, wrongly, that it knows who has been here.
*/

func TestSomebodyIsRememberedFromTheirFirstJoin(t *testing.T) {
	st := open(t)

	first := time.Now().Add(-time.Hour).UTC()
	later := time.Now().UTC()

	if err := st.Seen("4qu3mryghn", "andy", first); err != nil {
		t.Fatal(err)
	}

	if err := st.Seen("4qu3mryghn", "andy again", later); err != nil {
		t.Fatal(err)
	}

	people, err := st.People()
	if err != nil {
		t.Fatal(err)
	}

	if len(people) != 1 {
		t.Fatalf("recorded %d people for two joins by one signature", len(people))
	}

	person := people[0]

	if person.Rooms != 2 {
		t.Errorf("counted %d joins, wanted 2", person.Rooms)
	}

	if !person.FirstSeen.Equal(first) {
		t.Error("the first join was overwritten by the second")
	}

	// The name is whatever they last called themselves, because that is what
	// somebody reading the page will recognise.
	if person.Name != "andy again" {
		t.Errorf("name is %q, wanted the most recent one", person.Name)
	}
}

func TestBlockingIsWhatTheJoinReads(t *testing.T) {
	st := open(t)

	_ = st.Seen("4qu3mryghn", "andy", time.Now().UTC())

	if st.Blocked("4qu3mryghn") {
		t.Fatal("somebody was blocked before anybody blocked them")
	}

	if err := st.SetBlocked("4qu3mryghn", true, "kept opening rooms"); err != nil {
		t.Fatal(err)
	}

	if !st.Blocked("4qu3mryghn") {
		t.Error("a blocked signature was not refused")
	}

	// Joining again must not readmit them, which is the mistake the count being
	// updated in the same record invites.
	if err := st.Seen("4qu3mryghn", "andy", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}

	if !st.Blocked("4qu3mryghn") {
		t.Error("somebody blocked was readmitted by trying to join; a door that opens " +
			"when pushed is not a door")
	}
}

func TestNobodyElseIsBlockedByAccident(t *testing.T) {
	st := open(t)

	_ = st.Seen("4qu3mryghn", "andy", time.Now().UTC())
	_ = st.Seen("abcdefghij", "sam", time.Now().UTC())
	_ = st.SetBlocked("4qu3mryghn", true, "")

	if st.Blocked("abcdefghij") {
		t.Error("blocking one signature blocked another")
	}

	// And nobody the register has never seen, which is every anonymous visitor.
	if st.Blocked("0000000000") {
		t.Error("a signature nobody has ever used was refused")
	}
}

func TestForgettingSomebodyLetsThemBack(t *testing.T) {
	st := open(t)

	_ = st.Seen("4qu3mryghn", "andy", time.Now().UTC())
	_ = st.SetBlocked("4qu3mryghn", true, "")

	if err := st.ForgetPerson("4qu3mryghn"); err != nil {
		t.Fatal(err)
	}

	// Stated rather than assumed. Forgetting and readmitting are offered as two
	// separate things and it should be obvious that one implies the other.
	if st.Blocked("4qu3mryghn") {
		t.Error("somebody forgotten was still refused, so the register holds a block " +
			"nothing on the page can undo")
	}

	people, _ := st.People()
	if len(people) != 0 {
		t.Errorf("%d people left after forgetting the only one", len(people))
	}
}

func TestAJoinWithoutASignatureRecordsNothing(t *testing.T) {
	st := open(t)

	if err := st.Seen("", "somebody anonymous", time.Now().UTC()); err == nil {
		t.Error("a join with no signature was recorded; an anonymous visitor's is " +
			"different in every tab and a list of them is a list of tabs")
	}

	people, _ := st.People()
	if len(people) != 0 {
		t.Errorf("%d people recorded from a join with no signature", len(people))
	}
}
