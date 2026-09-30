import { act, fireEvent, render, screen } from "@testing-library/react";
import { DisconnectReason, RoomEvent } from "livekit-client";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Getting into a call and being put out of one.
 *
 * Two faults lived here and neither showed anything wrong on its own screen. A
 * device that would not start was inside the same try as the connection, so a
 * refused microphone turned a successful join into "could not join" and
 * disconnected somebody who was already in. And nothing listened for the call
 * ending from the other side, so somebody an administrator removed sat in front
 * of frozen pictures, still holding their camera.
 *
 * The room and both screens are stood in for. What is under test is the part
 * between them: what happens to a join when a device fails, and where somebody
 * ends up when the server lets them go.
 */

const notices = vi.hoisted(() => ({
	deviceFailed: vi.fn(),
	joinFailed: vi.fn(),
	sentAway: vi.fn(),
}));
vi.mock("@/live/notices", () => notices);

vi.mock("@/live/api", () => ({ join: vi.fn(async () => ({ url: "ws://x", token: "t" })) }));

class FakeRoom extends EventEmitter {
	disconnect = vi.fn(async () => {
		this.emit(RoomEvent.Disconnected, DisconnectReason.CLIENT_INITIATED);
	});
	localParticipant = {
		setMicrophoneEnabled: vi.fn(async () => {
			throw new DOMException("refused", "NotAllowedError");
		}),
		setCameraEnabled: vi.fn(async () => undefined),
	};
}

let made: FakeRoom;
vi.mock("@/live/room", () => ({
	create: () => made,
	connect: vi.fn(async () => undefined),
}));

vi.mock("@/routes/PreJoin", () => ({
	PreJoin: ({ onJoin }: { onJoin: (choices: object) => Promise<void> }) => (
		<button
			type="button"
			onClick={() => void onJoin({ name: "a", passphrase: "", camera: true, microphone: true })}
		>
			join
		</button>
	),
}));

vi.mock("@/routes/Room", () => ({ Room: () => <p>in the call</p> }));

const { App } = await import("./App");

async function joined() {
	render(<App />);
	await act(async () => {
		fireEvent.click(screen.getByText("join"));
	});
}

beforeEach(() => {
	made = new FakeRoom();
	for (const notice of Object.values(notices)) notice.mockClear();
});

describe("App", () => {
	it("keeps somebody in the call when a device will not start", async () => {
		await joined();

		expect(screen.getByText("in the call")).toBeTruthy();
		expect(made.disconnect).not.toHaveBeenCalled();
		expect(notices.joinFailed).not.toHaveBeenCalled();
		expect(notices.deviceFailed).toHaveBeenCalledWith("microphone", expect.any(DOMException));
		// The other device is not held hostage by the one that failed.
		expect(made.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true);
	});

	it("returns to the first screen, and says why, when removed", async () => {
		await joined();

		await act(async () => {
			made.emit(RoomEvent.Disconnected, DisconnectReason.PARTICIPANT_REMOVED);
		});

		expect(screen.queryByText("in the call")).toBeNull();
		expect(screen.getByText("join")).toBeTruthy();
		expect(notices.sentAway).toHaveBeenCalledWith(DisconnectReason.PARTICIPANT_REMOVED);
	});
});
