import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useIdle } from "@/hooks/useIdle";
import { useRoomForSide } from "@/hooks/useRoomFor";
import { useT } from "@/hooks/useT";
import type { Placement } from "@/live/controls";
import { retune, share } from "@/live/room";
import type { Room } from "livekit-client";
import { MessageSquare, Mic, MicOff, Video, VideoOff, Volume2 } from "lucide-react";
import { Leaving } from "./Leaving";
import { useState } from "react";
import { DeviceMenu } from "./DeviceMenu";
import type { Reaction } from "@/live/hands";
import { HandButton } from "./HandButton";
import { ShareButton } from "./ShareButton";
import { useLocalState } from "@/hooks/useLocalState";
import { canShareScreen } from "@/live/context";
import { deviceRefused } from "@/live/notices";

/**
 * The call controls.
 *
 * Microphone, camera, and screen are three independent switches: sharing does
 * not turn the camera off, which is what lets one person contribute two pictures
 * to the layout.
 */
export function ControlBar({
	room,
	handUp,
	onRaise,
	onReact,
	chatting,
	unread,
	listening,
	hidden,
	onChat,
	onListen,
	onLeave,
	host,
	where,
	onPlace,
}: {
	room: Room;
	/* Raised here and drawn on the tiles, so both come from one place: a
	   reaction is an event and holding it in two components would be two lists
	   that drift. */
	handUp: boolean;
	onRaise: (up: boolean) => void;
	onReact: (what: Reaction) => void;
	chatting: boolean;
	/** Something was said while the panel was closed. */
	unread: boolean;
	/** The sound panel is open. */
	listening: boolean;
	/** Out of the way, because the stage is filling the screen. */
	hidden?: boolean;
	onChat: () => void;
	onListen: () => void;
	onLeave: () => void;
	/** Whether this person may end the meeting rather than only leave it. */
	host: boolean;
	/** Where these sit, and whether they step aside. See live/controls.ts. */
	where: Placement;
	onPlace: (where: Placement) => void;
}) {
	const t = useT();
	const local = useLocalState(room);
	const [busy, setBusy] = useState(false);

	// Whether the pointer is on these, or somebody is on them with a keyboard.
	//
	// Without it the bar disappears out from under a menu somebody has just
	// opened: nothing here is a quick press, and the device list in particular
	// is read rather than glanced at. Held rather than done in CSS because a
	// hidden bar has been translated off the screen, where :hover never fires
	// again and there is no way back.
	//
	// Focus counts only where the browser would draw a focus ring for it.
	// Focus left behind by a click does not: a dropdown returns focus to its
	// trigger when it closes, and that trigger is in here — so pressing any
	// button once pinned the bar open for the rest of the call, which is a
	// setting that appears to do nothing. Somebody arriving by keyboard is the
	// case this is for, and that is exactly what :focus-visible means.
	const [near, setNear] = useState(false);

	const idle = useIdle(where === "idle" && !near);
	const away = hidden || idle;
	// Asked unconditionally and combined after, not `where === "side" && …`.
	// That reads well and is a hook behind a short circuit: the moment somebody
	// changes the setting the hook order changes with it, and React tears the
	// room down rather than moving a button.
	const roomy = useRoomForSide();

	// Down the side only where the window is tall enough to hold a column. See
	// useRoomForSide: at a phone's landscape height the ends of the bar are off
	// the screen and cannot be pressed.
	const side = where === "side" && roomy;

	// Every toggle is awaited and guarded, because each one asks the browser for
	// a device and a second click while that prompt is open leaves the button
	// and the device disagreeing about what is on.
	const guard =
		(action: () => Promise<unknown>, kind: "camera" | "microphone" = "camera") =>
		async () => {
			if (busy) return;
			setBusy(true);

			try {
				await action();
			} catch (err) {
				// A cancelled picker is an answer and needs no comment. A refused
				// permission is something somebody has to go and undo, so it says
				// so, and stays until they have.
				if (err instanceof DOMException && err.name === "NotAllowedError") {
					deviceRefused(kind);
				} else {
					console.debug("device toggle declined", err);
				}
			} finally {
				setBusy(false);
			}
		};

	return (
		<footer
			className={cn(
				// An island rather than a bar. A full-width strip with a rule
				// above it divides the window into a room and a chrome, and the
				// chrome then owns a band of height whether or not anything is
				// happening in it. Floating gives the pictures the whole window
				// and puts the controls on the same layer as everything else
				// that appears over them: the panel, the notices, the bubbles.
				"absolute z-20 flex gap-1.5",
				"rounded-full border border-border bg-surface/90 p-1.5 shadow-2xl backdrop-blur-md",
				side
					? // Down the right edge, vertically centred. Costs width,
						// which a wide window has and a tall one does not.
						"top-1/2 right-3 -translate-y-1/2 flex-col items-center"
					: cn(
							"-translate-x-1/2 left-1/2 items-center",
							// Clear of the home indicator, which the document asks
							// to draw under and nothing here was reading. Twenty
							// points from the bottom of the screen is underneath it
							// on every phone that has one.
							"bottom-[max(1.25rem,calc(env(safe-area-inset-bottom)+0.5rem))]",
						),
				// Steps aside when the stage takes the screen: somebody who asked
				// for the whole screen asked for the whole screen. And on the
				// same path, when the room has been left alone and the choice is
				// to have these out of the way.
				"transition-[transform,opacity] duration-200",
				away && "pointer-events-none opacity-0",
				away && (side ? "translate-x-24" : "translate-y-24"),
			)}
			onPointerEnter={() => setNear(true)}
			onPointerLeave={() => setNear(false)}
			onFocusCapture={(event) => {
				try {
					if ((event.target as Element).matches(":focus-visible")) setNear(true);
				} catch {
					// A browser without :focus-visible keeps the older behaviour,
					// which is to stay put while anything here has focus.
					setNear(true);
				}
			}}
			onBlurCapture={(event) => {
				// Only when focus has actually left, rather than moved between two
				// buttons inside.
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setNear(false);
			}}
		>
			<Toggle
				on={local.microphone}
				onLabel={t("Mute microphone")}
				offLabel={t("Unmute microphone")}
				onClick={guard(
					() => room.localParticipant.setMicrophoneEnabled(!local.microphone),
					"microphone",
				)}
			>
				{local.microphone ? <Mic /> : <MicOff />}
			</Toggle>

			<Toggle
				on={local.camera}
				onLabel={t("Turn camera off")}
				offLabel={t("Turn camera on")}
				onClick={guard(() => room.localParticipant.setCameraEnabled(!local.camera))}
			>
				{local.camera ? <Video /> : <VideoOff />}
			</Toggle>

			{/* Beside the camera rather than with the panels: it is a thing said
			    to the room, like speaking, and not a thing opened to be read. */}
			<HandButton up={handUp} onRaise={onRaise} onReact={onReact} />

			{canShareScreen() && (
				<ShareButton
					sharing={local.screen}
					onStart={(frameRate, quality) => void guard(() => share(room, true, frameRate, quality))()}
					onAdjust={(frameRate, quality) => void retune(room, frameRate, quality)}
					onStop={() => void guard(() => share(room, false, 30))()}
				/>
			)}

			<Toggle
				on={chatting}
				onLabel={t("Hide messages")}
				offLabel={t("Show messages")}
				signal
				onClick={onChat}
			>
				<MessageSquare />
				{/* Whether, not how many: in a call the first question is the only
				    one anybody asks. */}
				{unread && !chatting && (
					<span className="absolute top-0.5 right-0.5 size-2 rounded-full border-2 border-surface bg-tally" />
				)}
			</Toggle>

			{/* What can be heard, beside what can be said. Not in the device
			    menu above, which is about the microphone and camera somebody
			    speaks into — this is about everybody else. */}
			<Toggle
				on={listening}
				onLabel={t("Hide sound")}
				offLabel={t("Show sound")}
				onClick={onListen}
			>
				<Volume2 />
			</Toggle>

			<DeviceMenu room={room} where={where} onPlace={onPlace} />

			<span className={cn("bg-border", side ? "my-1 h-px w-5" : "mx-1 h-5 w-px")} />

			{/* Leaving and, for whoever runs the room, ending it. Together
			    because they are the same intention at two scales — somebody is
			    finished — and apart they meant a host pressed the red button, went
			    home, and left the meeting running behind them. */}
			<Leaving room={room} host={host} onLeave={onLeave} />
		</footer>
	);
}

/**
 * One control, lit or not.
 *
 * Off is drawn as unlit rather than as an alarm. Colouring every closed switch
 * red put four warnings in a row on a bar whose only real one is leaving, and a
 * warning that is always on stops being a warning. A muted microphone is a
 * choice somebody made, not a fault.
 *
 * `signal` marks a control where being on is itself worth announcing — an open
 * panel with something unread in it — and it takes the one colour that means
 * something is happening. Sharing takes that colour too, from a button of its
 * own: it carries a choice as well as a state, and a switch cannot ask a
 * question on its way on.
 */
function Toggle({
	on,
	onLabel,
	offLabel,
	onClick,
	children,
	signal,
}: {
	on: boolean;
	onLabel: string;
	offLabel: string;
	onClick: () => void;
	children: React.ReactNode;
	signal?: boolean;
}) {
	return (
		<Button
			variant={on && signal ? "default" : "secondary"}
			size="round"
			aria-label={on ? onLabel : offLabel}
			aria-pressed={on}
			onClick={onClick}
			className={cn("relative", !on && "text-fg-muted")}
		>
			{children}
		</Button>
	);
}
