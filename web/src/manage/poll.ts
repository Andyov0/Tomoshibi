import { useCallback, useEffect, useRef, useState } from "react";
import { SignedOut } from "./api";

/**
 * Ask the server the same question every couple of seconds.
 *
 * Polling rather than a stream. The server has nothing that pushes these
 * figures, so a stream would mean building one, and the audience is a handful
 * of people looking at a page occasionally. Two seconds is often enough to
 * watch a call go wrong and rare enough to cost nothing.
 *
 * Paused while the tab is hidden. A management page left open in a background
 * tab for a week is otherwise a request every two seconds for a week, answered
 * by a server that is meant to be carrying a meeting.
 */
export function usePoll<T>(
	ask: () => Promise<T>,
	{ every = 2000, onSignedOut }: { every?: number; onSignedOut?: () => void } = {},
) {
	const [value, setValue] = useState<T>();
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(true);

	// Held in a ref so that changing the question does not restart the timer,
	// and so the effect does not depend on a function most callers rebuild on
	// every render.
	const current = useRef(ask);
	current.current = ask;

	const signedOut = useRef(onSignedOut);
	signedOut.current = onSignedOut;

	const refresh = useCallback(async () => {
		try {
			setValue(await current.current());
			setError(undefined);
		} catch (err) {
			if (err instanceof SignedOut) {
				signedOut.current?.();
				return;
			}
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		let live = true;
		let timer: number | undefined;

		const tick = async () => {
			if (!live) return;

			if (!document.hidden) await refresh();

			// Scheduled after the answer rather than on an interval: a server
			// that has become slow would otherwise be asked again while it is
			// still working on the last one, which is the shape of a stampede.
			if (live) timer = window.setTimeout(tick, every);
		};

		void tick();

		// Asked again the moment somebody comes back, so the first thing they
		// see is current rather than however old the tab is.
		const onVisible = () => {
			if (!document.hidden) void refresh();
		};
		document.addEventListener("visibilitychange", onVisible);

		return () => {
			live = false;
			window.clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [every, refresh]);

	return { value, error, loading, refresh };
}
