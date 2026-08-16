import type { Participant, Room } from "livekit-client";
import { RoomEvent, Track } from "livekit-client";
import { toast } from "sonner";
import { t } from "./i18n";

/**
 * What is worth interrupting somebody for.
 *
 * Most of what happens in a call is not. A button somebody pressed does not
 * need to be reported back to the person who pressed it; a copied link answers
 * on the button itself; a connection that is down is a standing condition and
 * belongs in the banner over the stage, not in something that fades. What is
 * left is other people arriving and leaving, somebody else taking the stage
 * with a share, and the two failures a person can actually act on.
 *
 * One rule decides two things at once, and they are the same thing. A notice
 * about something that is over fades, and carries no way to close it: a target
 * that lives two seconds is one nobody hits, and pressing it would save nobody
 * anything. A notice about something still true does not leave on its own — so
 * it has to be possible to decide not to deal with it, which is the close
 * button, and it belongs to exactly those.
 */

/** How long an ordinary notice stays. Long enough to read four words. */
const BRIEFLY = 2200;

/** A share is longer, because the picture is about to change under you. */
const A_MOMENT = 3000;

/**
 * The longest any notice stays.
 *
 * Some of these used to stay for good, on the reasoning that something still
 * true is not an event: a refused camera is a state, and a state that fades
 * leaves somebody looking at a working-looking page with no camera in it.
 *
 * The reasoning was sound and the result was not. A notice that never leaves
 * sits in the corner through a whole meeting, over the pictures, long after the
 * person read it and either dealt with it or decided not to — and by the third
 * one nobody reads any of them. Ten seconds has been seen; forever has been
 * ignored. The ones worth acting on keep their close button so they can go
 * sooner.
 */
const AT_MOST = 10_000;


/**
 * Watch a room and report the handful of things worth reporting.
 *
 * Returns a function that stops watching. Nothing is queued: a notice missed
 * because the tab was hidden is a notice about something that already happened.
 */
export function watch(room: Room): () => void {
	const named = (participant: Participant) => participant.name || participant.identity;

	const onJoin = (participant: Participant) => {
		toast(t("{name} joined", { name: named(participant) }), { duration: BRIEFLY });
	};

	const onLeave = (participant: Participant) => {
		toast(t("{name} left", { name: named(participant) }), { duration: BRIEFLY });
	};

	const onPublished = (publication: { source: Track.Source }, participant: Participant) => {
		if (publication.source !== Track.Source.ScreenShare) return;
		toast(t("{name} started sharing", { name: named(participant) }), {
			duration: A_MOMENT,
			className: "is-signal",
		});
	};

	room.on(RoomEvent.ParticipantConnected, onJoin);
	room.on(RoomEvent.ParticipantDisconnected, onLeave);
	room.on(RoomEvent.TrackPublished, onPublished);

	return () => {
		room.off(RoomEvent.ParticipantConnected, onJoin);
		room.off(RoomEvent.ParticipantDisconnected, onLeave);
		room.off(RoomEvent.TrackPublished, onPublished);
	};
}

/**
 * A device the browser would not hand over.
 *
 * Given no duration, so it stays: unlike everything else here it is a thing
 * somebody has to go and fix, and it tells them where.
 */
export function deviceRefused(kind: "camera" | "microphone"): void {
	// Two whole phrases rather than one with the device substituted in. A
	// sentence built around a noun has to agree with it in most languages, and
	// the one place that would break is the one nobody tests: the error.
	toast.error(kind === "camera" ? t("Can't use your camera") : t("Can't use your microphone"), {
		description: t("Allow access from the icon in the address bar."),
		duration: AT_MOST,
		closeButton: true,
	});
}

/**
 * A room that would not open.
 *
 * The one failure between deciding to join and being in a call, and it used to
 * be shown by a red bar the page kept for itself — because the notices lived
 * inside the room, and this happens before there is one. They live at the root
 * now, so this can be said the same way as everything else.
 *
 * Given no duration, like a refused device: it is a thing somebody has to act
 * on, and a message about why they are not in the meeting should not disappear
 * while they are reading it.
 */
export function joinFailed(reason: string): void {
	toast.error(reason, { duration: AT_MOST, closeButton: true });
}

/**
 * Something somebody just pressed, which did not take.
 *
 * The management pages raise these, and they are the reason the notices moved
 * to the root: those pages had grown a third way of saying it, on top of the
 * client's toasts and the red bar its first screen kept for itself.
 *
 * It fades, unlike the two above, and the difference is the whole rule. A
 * refused device and a room that would not open are things somebody has to go
 * and do something about. A press that did not take is over: the room is still
 * there, the panel still works, and pressing again is the whole of the remedy.
 *
 * The words come from the caller because the server already sent a reason and
 * the client already turned it into a sentence. Rewriting it here would be a
 * second place for the same message to drift.
 */
export function actionFailed(reason: string): void {
	toast.error(reason, { duration: AT_MOST });
}

/**
 * Sound the browser refused to start on its own.
 *
 * The same category as a refused device, and shown the same way: it stays until
 * it is dealt with, because a call where nobody can be heard is not a condition
 * that should be allowed to fade away unnoticed. The difference is that this one
 * can be fixed from the notice itself — the click it asks for is the very thing
 * the browser was waiting for.
 *
 * Returns a function that takes the notice back down, for when playback starts
 * some other way.
 */
export function audioBlocked(resume: () => void): () => void {
	const id = toast(t("You can't hear anyone yet"), {
		description: t("Your browser needs one click first."),
		duration: AT_MOST,
		closeButton: true,
		action: { label: t("Turn on sound"), onClick: resume },
	});

	return () => toast.dismiss(id);
}
