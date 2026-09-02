import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/useT";
import { Refused } from "@/live/api";
import { type Arrangement, HOST_NOT_COMING_AFTER, arranged, askEvery, whenSaid } from "@/live/meeting";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The join screen's button, for somebody who arrived on a meeting link.
 *
 * Everything else on the screen is the ordinary one — name, camera,
 * microphone, which door to dial — because the whole point of arriving early is
 * to have those settled before the meeting. What changes is the button: the
 * meeting may not have begun, and until it has there is nothing to join.
 *
 * ## The shape is the waiting room's
 *
 * Nothing here happens until the button is pressed. An earlier draft began
 * asking the moment the page opened and joined the moment the answer came, and
 * that had two dead ends. A person still typing their name when the host
 * arrived was joined with no name, which the join refuses silently; and a
 * person who opened the link after it began was joined before they had looked
 * at their own camera, which is the one thing they were told they would get to
 * do first. So the button is pressed with a name in place, the asking starts
 * then, and where the meeting has already begun the button is simply Join.
 *
 * ## What it says while waiting
 *
 * When the meeting is for, in the reader's own clock and zone. Somebody who
 * opened a link at ten for a meeting at eleven should be told it is at eleven,
 * not left to wonder whether the waiting is the software being slow.
 *
 * ## When it stops
 *
 * When the host has come, when the meeting has ended or been cancelled, or two
 * hours after the arranged time with no host — which is said, because a screen
 * that waits for ever is indistinguishable from one that is broken.
 */
export function Waiting({
	token,
	name,
	onArranged,
	onGo,
	onStart,
}: {
	token: string;
	/** What they typed to be called. Nothing is asked until there is one. */
	name: string;
	/** The meeting, as soon as it is known and whenever it changes. */
	onArranged: (meeting: Arrangement) => void;
	/** Go in, carrying the invite the meeting produced. */
	onGo: (invite: string) => void;
	/**
	 * Go in as the host, which is what begins the meeting.
	 *
	 * A separate door from onGo because the host carries no invitation and
	 * needs none: their own join is the event everybody else is waiting for.
	 * The first version sent the host down the waiting path with everybody
	 * else, and the host then waited — for themselves.
	 */
	onStart: () => void;
}) {
	const t = useT();

	const [meeting, setMeeting] = useState<Arrangement>();
	const [gone, setGone] = useState<"ended" | "cancelled" | "not-coming">();
	const [asking, setAsking] = useState(false);

	const told = useRef(onArranged);
	told.current = onArranged;
	const go = useRef(onGo);
	go.current = onGo;
	const start = useRef(onStart);
	start.current = onStart;

	// Read once on arrival so the screen can say what it is for, before anybody
	// presses anything.
	const look = useCallback(async (): Promise<Arrangement | undefined> => {
		try {
			const said = await arranged(token);
			setMeeting(said);
			told.current(said);

			return said;
		} catch (whatever) {
			if (whatever instanceof Refused && whatever.reason === "no_such_meeting") {
				setGone("cancelled");
			}

			// Anything else — a rate limit, a lost connection — is not an answer
			// and changes nothing on the screen.
			return undefined;
		}
	}, [token]);

	useEffect(() => {
		void look();
	}, [look]);

	// The waiting itself.
	useEffect(() => {
		if (!asking) return;

		let live = true;
		let timer = 0;

		const tick = async () => {
			if (!live) return;

			const said = await look();

			if (!live) return;

			if (said?.ended) {
				setAsking(false);
				setGone("ended");
				return;
			}

			if (said?.started && said.invite) {
				setAsking(false);
				go.current(said.invite);
				return;
			}

			// The host is not coming. Said, rather than waited for.
			if (said && Date.now() - new Date(said.at).getTime() > HOST_NOT_COMING_AFTER) {
				setAsking(false);
				setGone("not-coming");
				return;
			}

			timer = window.setTimeout(tick, askEvery(said?.at ?? new Date().toISOString(), Date.now()));
		};

		timer = window.setTimeout(tick, 0);

		return () => {
			live = false;
			window.clearTimeout(timer);
		};
	}, [asking, look]);

	const when = meeting ? whenSaid(meeting.at) : "";

	if (gone === "cancelled") {
		return <p className="text-fg-muted text-sm">{t("That invitation is no longer good. Ask for another.")}</p>;
	}

	if (gone === "ended") {
		return <p className="text-fg-muted text-sm">{t("That meeting has ended.")}</p>;
	}

	if (gone === "not-coming") {
		return <p className="text-fg-muted text-sm">{t("The host has not started this meeting.")}</p>;
	}

	// Begun, and the invitation in hand: the ordinary button, because there is
	// nothing to wait for. Begun with no invitation means the room was closed
	// and the link has not caught up; the wait below finds that out.
	const ready = meeting?.started && meeting.invite;

	return (
		<div className="flex flex-col gap-2">
			{meeting && !ready && (
				<p className="text-fg-muted text-xs leading-snug">
					{meeting.mine
						? t("Your meeting is arranged for {when}. Joining starts it.", { when })
						: t("This meeting is arranged for {when}.", { when })}
				</p>
			)}

			<Button
				type="button"
				variant="primary"
				size="lg"
				className="w-full"
				disabled={!name.trim() || asking || !meeting}
				onClick={() => {
					if (ready && meeting?.invite) {
						go.current(meeting.invite);
						return;
					}

					// The host does not wait for the host.
					if (meeting?.mine) {
						start.current();
						return;
					}

					setAsking(true);
				}}
			>
				{asking ? (
					<span className="flex items-center gap-2">
						<Loader2 className="size-4 animate-spin" />
						{t("Waiting for the host to start the meeting.")}
					</span>
				) : ready ? (
					t("Join")
				) : meeting?.mine ? (
					t("Start the meeting")
				) : (
					t("Wait for the host")
				)}
			</Button>
		</div>
	);
}
