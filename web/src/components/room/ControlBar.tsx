import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "@/hooks/useT";
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
}) {
	const t = useT();
	const local = useLocalState(room);
	const [busy, setBusy] = useState(false);

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
				"-translate-x-1/2 absolute left-1/2 z-20 flex items-center gap-1.5",
				// Clear of the home indicator, which the document asks to draw
				// under and nothing here was reading. Twenty points from the
				// bottom of the screen is underneath it on every phone that has
				// one.
				"bottom-[max(1.25rem,calc(env(safe-area-inset-bottom)+0.5rem))]",
				"rounded-full border border-border bg-surface/90 p-1.5 shadow-2xl backdrop-blur-md",
				// Steps aside when the stage takes the screen: somebody who asked
				// for the whole screen asked for the whole screen.
				"transition-[transform,opacity] duration-200",
				hidden && "pointer-events-none translate-y-24 opacity-0",
			)}
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

			<DeviceMenu room={room} />

			<span className="mx-1 h-5 w-px bg-border" />

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
