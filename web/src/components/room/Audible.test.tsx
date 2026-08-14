import { act, render } from "@testing-library/react";
import { RoomAudioRenderer } from "@livekit/components-react";
import { Room, RoomEvent, Track } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AS_SENT, setBlocked, setVolume } from "@/live/hearing";
import { Audible } from "./Audible";

/*
 * What these guard is a fault that hides rather than announces itself.
 *
 * The call was silent for a while because nothing rendered the voices, and
 * every other signal — the tally, the microphone icon, somebody's own level
 * meter — kept saying it worked. A type error would have caught a missing
 * component; nothing catches a component that was never written.
 *
 * The library was also the reason it stayed hidden once: an earlier hook from
 * the same package returned empty forever without its provider, silently, and
 * this application deliberately puts no context above its tree. So the point
 * below is not that the renderer exists but that it is reached the only way
 * this application can reach it.
 */

// The record is one object for the whole application, which is what lets a
// panel in one corner change what a tile in another says. Clearing storage does
// not clear it, so each test starts by putting the one identity below back to
// how everybody starts.
function forget() {
	localStorage.clear();
	setVolume(IDENTITY, "voice", AS_SENT.volume);
	setBlocked(IDENTITY, "voice", AS_SENT.blocked);
	setVolume(IDENTITY, "screen", AS_SENT.volume);
	setBlocked(IDENTITY, "screen", AS_SENT.blocked);
}

beforeEach(forget);
afterEach(() => {
	vi.restoreAllMocks();
	forget();
});

describe("Audible", () => {
	it("renders sound without a provider above it", () => {
		const room = new Room();
		const { container } = render(<Audible room={room} />);

		// The renderer's own container: hidden, because sound has no picture.
		// Its presence is what says the component mounted and reached the room
		// rather than bailing out.
		const holder = container.querySelector("div");
		expect(holder).not.toBeNull();
		expect(holder?.style.display).toBe("none");
	});

	/*
	 * The differential half. Without this the test above would still pass if the
	 * room were being found some other way, and the bug it guards against —
	 * handing the library nothing and getting silence — would slip straight
	 * through again.
	 */
	it("depends on the room it is given, not on a context", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect(() => render(<RoomAudioRenderer />)).toThrow();
		expect(() => render(<RoomAudioRenderer room={new Room()} />)).not.toThrow();
	});
});

const IDENTITY = "taaaaaaaaaa-0123456789abcdef0123456789abcdef";

/*
 * The half of this that the media library will not do for anybody.
 *
 * A volume is kept on a remote participant and a block on a publication, and
 * both of those objects are built again from nothing more often than one would
 * expect: a full reconnect disconnects and re-adds every participant, and a
 * share stopped and started again is a new publication. Neither loss announces
 * itself — the call carries on and the setting is simply gone — so the record
 * lives in this application and is put back on the room whenever it changes
 * underneath.
 *
 * Standing a real media server up to prove that is not on. What is exercised
 * here is the participant, which is the object the settings are put onto and the
 * one that gets replaced.
 */

/** A remote participant with one publication, as far as this is concerned. */
function somebody(room: Room, enabled = true) {
	const publication = {
		source: Track.Source.Microphone,
		isEnabled: enabled,
		setEnabled: vi.fn(function (this: void, next: boolean) {
			publication.isEnabled = next;
		}),
	};

	const participant = {
		identity: IDENTITY,
		isLocal: false,
		// Walked by the library's own renderer, which shares this room. Empty,
		// because nothing here is about what it draws.
		trackPublications: new Map(),
		setVolume: vi.fn(),
		getTrackPublication: (source: Track.Source) =>
			source === Track.Source.Microphone ? publication : undefined,
	};

	// The map the room keeps them in, which is what `apply` walks.
	(room.remoteParticipants as Map<string, unknown>).set(IDENTITY, participant);

	return { participant, publication };
}

describe("Audible and what has been decided about hearing people", () => {
	it("puts the settings on somebody who was already there", () => {
		setVolume(IDENTITY, "voice", 0.25);

		const room = new Room();
		const { participant } = somebody(room);

		render(<Audible room={room} />);

		// At once rather than on an event: a participant already in the room
		// when this mounts announces nothing.
		expect(participant.setVolume).toHaveBeenCalledWith(0.25, Track.Source.Microphone);
	});

	it("puts them back when the room says something was replaced", () => {
		setVolume(IDENTITY, "voice", 0.5);

		const room = new Room();
		const { participant } = somebody(room);

		render(<Audible room={room} />);
		participant.setVolume.mockClear();

		// The shape a full reconnect and a restarted share both arrive in.
		act(() => {
			room.emit(RoomEvent.TrackPublished, {} as never, {} as never);
		});

		expect(participant.setVolume).toHaveBeenCalledWith(0.5, Track.Source.Microphone);
	});

	it("follows a decision made while the call is going", () => {
		const room = new Room();
		const { publication } = somebody(room);

		render(<Audible room={room} />);

		act(() => setBlocked(IDENTITY, "voice", true));

		// Stopped at the media server rather than turned down here, which is the
		// difference between hearing nothing and paying for it anyway.
		expect(publication.setEnabled).toHaveBeenCalledWith(false);
	});

	/*
	 * `setEnabled` sends the media server a settings update every time it is
	 * called with a new answer, and this runs for everybody in the room on every
	 * arrival. Left unguarded, one person joining a call of nine is nine
	 * messages saying nothing changed.
	 */
	it("says nothing to the server about somebody nobody has decided anything about", () => {
		const room = new Room();
		const { publication } = somebody(room);

		render(<Audible room={room} />);
		act(() => {
			room.emit(RoomEvent.TrackPublished, {} as never, {} as never);
		});

		expect(publication.setEnabled).not.toHaveBeenCalled();
	});
});
