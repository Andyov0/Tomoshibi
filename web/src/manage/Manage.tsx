import { useCallback, useEffect, useState } from "react";
import { type Who, api } from "./api";
import { usePoll } from "./poll";
import { AdminsPanel } from "./AdminsPanel";
import { AccountsPanel } from "./AccountsPanel";
import { NowPanel } from "./NowPanel";
import { RelaysPanel } from "./RelaysPanel";
import { RoomsPanel } from "./RoomsPanel";
import { RuntimePanel } from "./RuntimePanel";
import { SignIn } from "./SignIn";
import { type Panel, PANELS, Shell } from "./Shell";

/**
 * The management pages.
 *
 * Whether somebody is signed in is asked of the server rather than remembered
 * here, because the cookie carrying the session cannot be read by anything on
 * this page — which is the point of it. So the first thing this does is ask who
 * it is talking to, and every later refusal sends it back to the same question.
 */
export function Manage() {
	const [who, setWho] = useState<Who>();
	const [asking, setAsking] = useState(true);
	const [panel, setPanel] = useState<Panel>(() => remembered());

	// Polled here rather than inside the panel that shows it, because the
	// reading has to survive leaving that panel: it sits in the rail and in the
	// crown, which are on screen whichever page is. Polling it in one place also
	// means one request rather than two when the panel is open.
	const { value: load } = usePoll(api.now, { every: 5000, onSignedOut: () => setWho(undefined) });

	// What the deployment says its line carries, asked for on signing in.
	//
	// api.runtime() tells units.ts the answer, and until this was here the only
	// thing that called it was the Runtime panel — so every share-of-the-uplink
	// bar was drawn against a hardcoded gigabit unless somebody had happened to
	// open that page first. On a hundred megabit line the rail said five per
	// cent while the line was half full, and it said it more convincingly than
	// most numbers on the page because there was a bar beside it.
	//
	// Once rather than polled: a line does not change while somebody is looking
	// at it, and the answer is kept in a module rather than in state.
	useEffect(() => {
		if (!who) return;

		void api.runtime().catch(() => {});
	}, [who]);

	const identify = useCallback(async () => {
		try {
			setWho(await api.whoami());
		} catch {
			setWho(undefined);
		} finally {
			setAsking(false);
		}
	}, []);

	useEffect(() => {
		void identify();
	}, [identify]);

	// A session that has expired is not an error worth a message. Whoever is
	// here was signed in a moment ago and simply has to say so again.
	const signedOut = useCallback(() => setWho(undefined), []);

	const choose = useCallback((next: Panel) => {
		setPanel(next);
		window.location.hash = `#${next.toLowerCase()}`;
	}, []);

	const signOut = useCallback(async () => {
		try {
			await api.signOut();
		} finally {
			setWho(undefined);
		}
	}, []);

	if (asking) return <div className="min-h-full bg-bg" />;
	if (!who) return <SignIn onIn={identify} />;

	return (
		<Shell
			who={who}
			panel={panel}
			onPanel={choose}
			onSignOut={signOut}
			load={
				load && {
					out: load.bytes.outPerSec,
					rooms: load.rooms,
					clients: load.clients,
				}
			}
		>
			{panel === "Now" && <NowPanel now={load} onSignedOut={signedOut} />}
			{panel === "Rooms" && (
				<RoomsPanel canModerate={who.can.includes("moderate")} onSignedOut={signedOut} />
			)}
			{panel === "Accounts" && (
				<AccountsPanel canModerate={who.can.includes("moderate")} onSignedOut={signedOut} />
			)}
			{panel === "Relays" && (
				<RelaysPanel canModerate={who.can.includes("moderate")} onSignedOut={signedOut} />
			)}
			{panel === "Admins" && (
				<AdminsPanel canModerate={who.can.includes("moderate")} onSignedOut={signedOut} />
			)}
			{panel === "Runtime" && <RuntimePanel onSignedOut={signedOut} />}
		</Shell>
	);
}

/** Which panel the address names, so a page can be reloaded where it was. */
function remembered(): Panel {
	const named = window.location.hash.replace(/^#/, "").toLowerCase();
	return PANELS.find((one) => one.toLowerCase() === named) ?? "Now";
}

