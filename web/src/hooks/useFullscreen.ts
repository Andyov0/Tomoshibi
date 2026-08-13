import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Put one element on the whole screen.
 *
 * The element rather than the document, so what fills the screen is the picture
 * and not the page around it. State is read from the browser rather than
 * remembered here, because there are ways out this code never hears about:
 * Escape, the system menu, and a window losing focus all leave fullscreen
 * without going through the function that entered it.
 */
export function useFullscreen<T extends HTMLElement>() {
	const ref = useRef<T>(null);
	const [active, setActive] = useState(false);

	useEffect(() => {
		const sync = () => setActive(document.fullscreenElement === ref.current);

		document.addEventListener("fullscreenchange", sync);
		return () => document.removeEventListener("fullscreenchange", sync);
	}, []);

	const toggle = useCallback(() => {
		if (document.fullscreenElement) {
			// Not necessarily ours: leaving whatever is there is what somebody
			// pressing this expects, and asking for ours while another element
			// holds it would be refused.
			void document.exitFullscreen().catch(() => {});
			return;
		}

		// Refused when the browser does not consider this a user gesture, and on
		// iPhone where the API is absent for anything but a video element. The
		// button simply does nothing there, which beats an error about a feature
		// somebody cannot have.
		void ref.current?.requestFullscreen?.().catch(() => {});
	}, []);

	return { ref, active, toggle, supported: typeof document !== "undefined" && document.fullscreenEnabled };
}
