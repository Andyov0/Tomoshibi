import { afterEach, expect, it } from "vitest";
import { rememberedVolume } from "./WatchScreen";

/*
A video's volume, this viewer's own: full until they turn it down. Nothing kept
reads back as null, which made every video start silent.
*/

afterEach(() => localStorage.clear());

it("plays a video at full volume until told otherwise, and as told after", () => {
	expect(rememberedVolume()).toBe(1);
	localStorage.setItem("meet-live.watch-volume", "0.4");
	expect(rememberedVolume()).toBe(0.4);
	localStorage.setItem("meet-live.watch-volume", "-3");
	expect(rememberedVolume()).toBe(1);
});
