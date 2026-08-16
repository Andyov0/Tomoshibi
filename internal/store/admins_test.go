package store

import (
	"errors"
	"testing"

	"tomoshibi/internal/config"
)

/*
What these guard is the one mistake on this page that cannot be undone from it.

Removing an administrator is ordinary and reversible: somebody else adds them
back. Removing the last one who can add anybody back is not. Recovering means
editing a file on the host and restarting the process, which ends every call in
progress — so a deployment that made this mistake at a bad moment pays for it
twice.

It is refused in the store rather than at the API, because the store is what the
running deployment reads and there is more than one way to reach it. Taking the
capability away by editing somebody is the same mistake wearing different
clothes, and a check that only guarded deletion would have let it through.
*/

var (
	owner  = Admin{Trip: "4qu3mryghn", Name: "andy", Can: []string{config.Moderate}}
	second = Admin{Trip: "abcdefghij", Name: "sam", Can: []string{config.Moderate}}
	viewer = Admin{Trip: "0123456789", Name: "kim"}
)

func TestTheLastModeratorCannotBeRemoved(t *testing.T) {
	st := open(t)

	if _, err := st.AdoptAdmins([]config.Admin{owner.Configured()}); err != nil {
		t.Fatal(err)
	}

	// An observer is no help: they cannot add anybody back, so removing the one
	// moderator still leaves nobody who can.
	if err := st.AddAdmin(viewer); err != nil {
		t.Fatal(err)
	}

	if err := st.RemoveAdmin(owner.Trip); !errors.Is(err, ErrLastModerator) {
		t.Fatalf("removing the last moderator gave %v, wanted a refusal; recovering from "+
			"this means editing a file on the host and restarting, which ends every call "+
			"in progress", err)
	}
}

// The same mistake by another route. Somebody who takes their own moderate away
// has locked the deployment just as thoroughly as somebody who deleted it.
func TestTheLastModeratorCannotBeDemoted(t *testing.T) {
	st := open(t)

	if _, err := st.AdoptAdmins([]config.Admin{owner.Configured()}); err != nil {
		t.Fatal(err)
	}

	demoted := owner
	demoted.Can = []string{config.Observe}

	if err := st.UpdateAdmin(demoted); !errors.Is(err, ErrLastModerator) {
		t.Fatalf("demoting the last moderator gave %v, wanted a refusal: taking the "+
			"capability away leaves exactly the deployment that deleting it would", err)
	}
}

func TestOneOfTwoModeratorsCanGo(t *testing.T) {
	st := open(t)

	if _, err := st.AdoptAdmins([]config.Admin{owner.Configured()}); err != nil {
		t.Fatal(err)
	}

	if err := st.AddAdmin(second); err != nil {
		t.Fatal(err)
	}

	if err := st.RemoveAdmin(owner.Trip); err != nil {
		t.Fatalf("removing one of two moderators was refused: %v", err)
	}

	list, err := st.Admins()
	if err != nil {
		t.Fatal(err)
	}

	if len(list) != 1 || list[0].Trip != second.Trip {
		t.Errorf("left %v, wanted only %s", list, second.Trip)
	}
}

func TestSomebodyIsNotAddedTwice(t *testing.T) {
	st := open(t)

	if err := st.AddAdmin(owner); err != nil {
		t.Fatal(err)
	}

	// Refused rather than overwritten. The two read the same in a hurry and
	// mean opposite things: silently replacing would change what somebody may
	// do without anybody choosing it.
	if err := st.AddAdmin(Admin{Trip: owner.Trip, Name: "someone else"}); !errors.Is(err, ErrAdminExists) {
		t.Errorf("adding the same signature twice gave %v, wanted a refusal", err)
	}
}

func TestOnlyASignatureIsAccepted(t *testing.T) {
	st := open(t)

	for _, tc := range []struct {
		why  string
		trip string
	}{
		{"empty", ""},
		{"too short", "abc"},
		{"too long", "abcdefghijk"},
		{"upper case", "ABCDEFGHIJ"},
		{"punctuation", "abcdefgh-j"},
		{"a passphrase by mistake", "correct horse battery"},
	} {
		if err := st.AddAdmin(Admin{Trip: tc.trip, Name: "x"}); err == nil {
			t.Errorf("%s (%q) was accepted as a signature", tc.why, tc.trip)
		}
	}
}

// The configuration file is the way back in. It is adopted once and then left
// alone, so that somebody deliberately removed does not reappear on restart —
// but a deployment whose store was lost has to be recoverable by editing a file
// on the host, or it has locked out the person who owns the machine.
func TestTheFileIsAdoptedOnceAndThenLeftAlone(t *testing.T) {
	st := open(t)

	adopted, err := st.AdoptAdmins([]config.Admin{owner.Configured()})
	if err != nil || !adopted {
		t.Fatalf("first adoption: adopted=%v err=%v", adopted, err)
	}

	if err := st.AddAdmin(second); err != nil {
		t.Fatal(err)
	}

	if err := st.RemoveAdmin(owner.Trip); err != nil {
		t.Fatal(err)
	}

	adopted, err = st.AdoptAdmins([]config.Admin{owner.Configured()})
	if err != nil {
		t.Fatal(err)
	}

	if adopted {
		t.Error("the file was adopted a second time; somebody removed on purpose would " +
			"come back on every restart")
	}

	list, err := st.Admins()
	if err != nil {
		t.Fatal(err)
	}

	if len(list) != 1 || list[0].Trip != second.Trip {
		t.Errorf("after a second start the list is %v, wanted only %s", list, second.Trip)
	}
}

func TestObserveIsHeldWithoutBeingGranted(t *testing.T) {
	// Empty Can is the safe reading of an entry somebody wrote in a hurry: they
	// can look, and nothing more.
	if !viewer.Allows(config.Observe) {
		t.Error("an administrator with nothing granted cannot even observe")
	}

	if viewer.Allows(config.Moderate) {
		t.Error("an administrator with nothing granted can moderate")
	}
}
