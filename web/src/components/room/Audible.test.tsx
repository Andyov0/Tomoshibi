import { render } from "@testing-library/react";
import { RoomAudioRenderer } from "@livekit/components-react";
import { Room } from "livekit-client";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => vi.restoreAllMocks());

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
