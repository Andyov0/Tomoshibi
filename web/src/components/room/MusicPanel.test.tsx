import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Room } from "livekit-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MusicPanel } from "./MusicPanel";

/*
The music panel.

The one thing it must get right is what it hands the player: the address of the
track it was pressed on, at the rate the library read off that file -- a wrong
rate is a resampled track, which is the loss the whole path exists to avoid --
and nothing at all for a track the account may not play.
*/

const searchLibrary = vi.fn();
const describeTrack = vi.fn();
const playLibraryTrack = vi.fn(async () => ({}));

vi.mock("@/live/music", async (original) => {
	const real = await original<typeof import("@/live/music")>();
	return {
		...real,
		searchLibrary: (...args: unknown[]) => searchLibrary(...args),
		describeTrack: (...args: unknown[]) => describeTrack(...args),
	};
});

vi.mock("@/live/sound", () => ({
	playLibraryTrack: (...args: unknown[]) => playLibraryTrack(...(args as [])),
	nowPlaying: () => undefined,
	subscribePlaying: () => () => {},
	stopListening: vi.fn(),
	rememberedLossless: () => true,
}));

vi.mock("@/live/notices", () => ({ actionFailed: vi.fn(), losslessGaveUp: vi.fn() }));

const room = {} as Room;
const track = { id: "0039", title: "Sunny Day", artists: ["Jay"], album: "Ye Hui Mei", cover: "", duration: 269 };

beforeEach(() => {
	searchLibrary.mockReset().mockResolvedValue([track]);
	describeTrack.mockReset();
	playLibraryTrack.mockClear();
});

async function find(libraries = [{ id: "qq", name: "QQ", signedIn: true }]) {
	render(<MusicPanel room={room} libraries={libraries} onClose={vi.fn()} />);
	fireEvent.change(screen.getByRole("textbox", { name: "Search songs" }), { target: { value: "sunny" } });
	fireEvent.click(screen.getByRole("button", { name: "Search" }));
	return screen.findByRole("button", { name: /Sunny Day/ });
}

describe("playing a track", () => {
	it("hands the player the track's address at the rate its file has", async () => {
		describeTrack.mockResolvedValue({ format: "flac", rate: 44_100, channels: 2, bits: 24, tier: "lossless" });

		fireEvent.click(await find());

		await waitFor(() => expect(playLibraryTrack).toHaveBeenCalledTimes(1));
		const [, audio, lossless] = playLibraryTrack.mock.calls[0] as unknown as [
			Room,
			{ url: string; rate: number; now: { quality: string } },
			boolean,
		];
		expect(searchLibrary).toHaveBeenCalledWith("qq", "sunny");
		expect(describeTrack).toHaveBeenCalledWith("qq", "0039", "lossless");
		expect(audio.url).toBe("/api/music/audio?source=qq&id=0039&quality=lossless");
		expect(audio.rate).toBe(44_100);
		// What the sender needs to recover the file's own integers; see decodedToInt24.
		expect(audio).toMatchObject({ format: "flac", bits: 24 });
		expect(audio.now.quality).toBe("FLAC · 24-bit · 44.1 kHz");
		expect(lossless).toBe(true);
	});

	it("asks for the highest tier only when it is chosen", async () => {
		describeTrack.mockResolvedValue({ format: "flac", rate: 192_000, channels: 2, bits: 24, tier: "master" });
		render(<MusicPanel room={room} libraries={[{ id: "qq", name: "QQ", signedIn: true }]} onClose={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "Highest" }));
		fireEvent.change(screen.getByRole("textbox", { name: "Search songs" }), { target: { value: "sunny" } });
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		fireEvent.click(await screen.findByRole("button", { name: /Sunny Day/ }));

		await waitFor(() => expect(playLibraryTrack).toHaveBeenCalledTimes(1));
		expect(describeTrack).toHaveBeenCalledWith("qq", "0039", "best");
		localStorage.clear();
	});

	it("plays nothing, and says why, for a track the account may not play", async () => {
		describeTrack.mockResolvedValue("unavailable");

		fireEvent.click(await find());

		expect(await screen.findByText(/not available to the library's account/)).toBeTruthy();
		expect(playLibraryTrack).not.toHaveBeenCalled();
	});
});

it("says a library that is not signed in plays at most 320 kbps", () => {
	render(<MusicPanel room={room} libraries={[{ id: "ne", name: "NE", signedIn: false }]} onClose={vi.fn()} />);
	expect(screen.getByText(/at most 320 kbps/)).toBeTruthy();
});

it("starts on a library that is signed in", async () => {
	render(
		<MusicPanel
			room={room}
			libraries={[
				{ id: "ne", name: "NE", signedIn: false },
				{ id: "qq", name: "QQ", signedIn: true },
			]}
			onClose={vi.fn()}
		/>,
	);
	expect(screen.getByRole("tab", { name: "QQ" }).getAttribute("aria-selected")).toBe("true");
});
