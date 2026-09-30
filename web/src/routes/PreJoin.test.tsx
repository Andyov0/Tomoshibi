import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreJoin } from "./PreJoin";

/*
 * The way out of this screen when the server says no.
 *
 * A join can be refused for reasons nobody typing here can see coming: a room
 * only administrators may open, a name the server will not have, a rate limit.
 * Every one of those left the button reading "Joining…" for good, with a notice
 * beside it explaining why and nothing to press. The only way on was to reload
 * the page, which is not a thing an interface should ever ask for.
 *
 * It went unnoticed because the successful path hides it: on a join that works
 * this screen is replaced, so the button nobody put back is a button nobody
 * sees.
 */

const camera = { stop: vi.fn(), attach: vi.fn(), detach: vi.fn() };

beforeEach(() => {
	localStorage.clear();

	// The preview asks for a camera on mount. Nothing here is about the picture,
	// and a real request would hang in a test environment that has no devices.
	vi.mock("livekit-client", async (original) => ({
		...(await original<typeof import("livekit-client")>()),
		createLocalVideoTrack: () => Promise.resolve(camera),
	}));

	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({ openedBy: "anyone", source: "" }))),
	);

	// This screen refuses to draw a form where a browser would not hand over a
	// camera, and a test environment is exactly such a browser. Both halves of
	// that check are answered here so the form under test is the one people see.
	Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
	Object.defineProperty(navigator, "mediaDevices", {
		value: { enumerateDevices: async () => [], addEventListener() {}, removeEventListener() {} },
		configurable: true,
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	localStorage.clear();
});

function open(onJoin: (choices: unknown) => Promise<void>) {
	render(<PreJoin room="standup" onRoomChange={vi.fn()} onJoin={onJoin as never} />);
}

async function joinAs(name: string) {
	fireEvent.change(screen.getByLabelText("Your name"), { target: { value: name } });
	fireEvent.click(screen.getByRole("button", { name: "Join" }));
}

describe("PreJoin", () => {
	it("gives the button back when the server refuses", async () => {
		const refuse = vi.fn(() => Promise.reject(new Error("that room has not been opened")));

		open(refuse as never);
		await joinAs("Alex");

		await waitFor(() => expect(refuse).toHaveBeenCalled());

		// Pressable again, saying what it says when nothing is happening. Without
		// this the screen is a dead end with a notice on it.
		await waitFor(() => {
			const button = screen.getByRole("button", { name: "Join" });
			expect(button.textContent).toBe("Join");
			expect((button as HTMLButtonElement).disabled).toBe(false);
		});
	});

	// And says so while it is waiting, which is the half that already worked.
	it("says what it is doing while the server thinks", async () => {
		let settle: () => void = () => {};
		const slow = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)));

		open(slow as never);
		await joinAs("Alex");

		await waitFor(() => expect(screen.getByRole("button", { name: "Joining…" })).toBeDefined());

		await act(async () => {
			settle();
		});
	});

	// Twice through is one join, not two. A second press while the first is out
	// would mint a second identity and evict the first from the room.
	it("cannot be pressed twice while it is waiting", async () => {
		const slow = vi.fn(() => new Promise<void>(() => {}));

		open(slow as never);
		await joinAs("Alex");

		await waitFor(() => expect(slow).toHaveBeenCalledTimes(1));

		fireEvent.click(screen.getByRole("button", { name: "Joining…" }));
		expect(slow).toHaveBeenCalledTimes(1);
	});

	/*
	 * The passphrase that signs a name is also the one that signs in to the
	 * management pages. It was kept in local storage for a while so that the
	 * field would be filled on the next visit, which on an administrator's
	 * machine meant their credential in plain text for any script on the origin
	 * and anybody who used the browser next.
	 */
	it("keeps no passphrase of its own", async () => {
		const succeed = vi.fn(() => Promise.resolve());

		open(succeed as never);
		fireEvent.change(screen.getByRole("textbox", { name: "Your name" }), {
			target: { value: "Alex" },
		});
		fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "quietly" } });
		fireEvent.click(screen.getByRole("button", { name: "Join" }));

		await waitFor(() => expect(succeed).toHaveBeenCalled());

		const kept = Object.keys(localStorage).map((key) => localStorage.getItem(key));
		expect(kept.some((value) => value?.includes("quietly"))).toBe(false);

		cleanup();
		open(succeed as never);

		expect((screen.getByLabelText("Passphrase") as HTMLInputElement).value).toBe("");
	});

	// What an earlier build wrote is still on people's machines, and leaving it
	// there would leave the credential where this change was meant to take it.
	it("removes the copy an earlier build kept", () => {
		localStorage.setItem("meet-live.passphrase", "quietly");

		open(vi.fn(() => Promise.resolve()) as never);

		expect((screen.getByLabelText("Passphrase") as HTMLInputElement).value).toBe("");
		expect(localStorage.getItem("meet-live.passphrase")).toBeNull();
	});

	// Blocked site data throws from local storage rather than answering empty,
	// and this screen read it while drawing and wrote it before joining.
	it("draws and joins in a browser that will not keep anything", async () => {
		const succeed = vi.fn(() => Promise.resolve());
		const refuse = () => {
			throw new DOMException("blocked", "SecurityError");
		};
		const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(refuse);
		const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(refuse);

		try {
			open(succeed as never);
			await joinAs("Alex");

			await waitFor(() => expect(succeed).toHaveBeenCalled());
		} finally {
			get.mockRestore();
			set.mockRestore();
		}
	});
});
