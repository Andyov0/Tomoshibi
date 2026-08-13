import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SHARE_FRAME_RATES, type ShareFrameRate, share } from "@/live/room";
import type { Room } from "livekit-client";
import {
	MessageSquare,
	Mic,
	MicOff,
	MonitorOff,
	MonitorUp,
	PhoneOff,
	Video,
	VideoOff,
} from "lucide-react";
import { useState } from "react";
import { DeviceMenu } from "./DeviceMenu";
import { useLocalState } from "@/hooks/useLocalState";

/**
 * The call controls.
 *
 * Microphone, camera, and screen are three independent switches: sharing does
 * not turn the camera off, which is what lets one person contribute two pictures
 * to the layout.
 */
export function ControlBar({
	room,
	chatting,
	unread,
	hidden,
	onChat,
	onLeave,
}: {
	room: Room;
	chatting: boolean;
	/** Something was said while the panel was closed. */
	unread: boolean;
	/** Out of the way, because the stage is filling the screen. */
	hidden?: boolean;
	onChat: () => void;
	onLeave: () => void;
}) {
	const local = useLocalState(room);
	const [frameRate, setFrameRate] = useState<ShareFrameRate>(30);
	const [busy, setBusy] = useState(false);

	// Every toggle is awaited and guarded, because each one asks the browser for
	// a device and a second click while that prompt is open leaves the button
	// and the device disagreeing about what is on.
	const guard = (action: () => Promise<unknown>) => async () => {
		if (busy) return;
		setBusy(true);
		try {
			await action();
		} catch (err) {
			// A refused permission or a cancelled picker is an answer, not a
			// fault. The button falls back to what the device actually did.
			console.debug("device toggle declined", err);
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
				"-translate-x-1/2 absolute bottom-5 left-1/2 z-20 flex items-center gap-1.5",
				"rounded-full border border-border bg-surface/90 p-1.5 shadow-2xl backdrop-blur-md",
				// Steps aside when the stage takes the screen: somebody who asked
				// for the whole screen asked for the whole screen.
				"transition-[transform,opacity] duration-200",
				hidden && "pointer-events-none translate-y-24 opacity-0",
			)}
		>
			<Toggle
				on={local.microphone}
				onLabel="Mute microphone"
				offLabel="Unmute microphone"
				onClick={guard(() => room.localParticipant.setMicrophoneEnabled(!local.microphone))}
			>
				{local.microphone ? <Mic /> : <MicOff />}
			</Toggle>

			<Toggle
				on={local.camera}
				onLabel="Turn camera off"
				offLabel="Turn camera on"
				onClick={guard(() => room.localParticipant.setCameraEnabled(!local.camera))}
			>
				{local.camera ? <Video /> : <VideoOff />}
			</Toggle>

			<Toggle
				on={local.screen}
				onLabel="Stop sharing"
				offLabel="Share your screen"
				signal
				onClick={guard(() => share(room, !local.screen, frameRate))}
			>
				{local.screen ? <MonitorOff /> : <MonitorUp />}
			</Toggle>

			<Toggle
				on={chatting}
				onLabel="Hide messages"
				offLabel="Show messages"
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

			<FrameRate value={frameRate} onChange={setFrameRate} disabled={local.screen} />

			<DeviceMenu room={room} />

			<span className="mx-1 h-5 w-px bg-border" />

			<Button variant="danger" size="icon" aria-label="Leave" onClick={onLeave}>
				<PhoneOff />
			</Button>
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
 * `signal` marks the controls where being on is itself worth announcing —
 * sharing a screen, an open panel with something unread in it — and those take
 * the one colour that means something is happening.
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
			size="icon"
			aria-label={on ? onLabel : offLabel}
			aria-pressed={on}
			onClick={onClick}
			className={cn("relative", !on && "text-fg-muted")}
		>
			{children}
		</Button>
	);
}

/**
 * Frame rate for screen sharing.
 *
 * Locked while sharing: changing it restarts the capture, which would drop the
 * stream and prompt again for a surface to share. Pick before you start.
 */
function FrameRate({
	value,
	onChange,
	disabled,
}: {
	value: ShareFrameRate;
	onChange: (value: ShareFrameRate) => void;
	disabled: boolean;
}) {
	return (
		<div
			className={cn(
				"ml-1 flex overflow-hidden rounded-lg border border-border",
				disabled && "pointer-events-none opacity-40",
			)}
			title={disabled ? "Stop sharing to change the frame rate" : "Screen share frame rate"}
		>
			{SHARE_FRAME_RATES.map((rate: ShareFrameRate) => (
				<button
					key={rate}
					type="button"
					aria-pressed={value === rate}
					aria-label={`Share at ${rate} frames per second`}
					onClick={() => onChange(rate)}
					className={cn(
						"px-2.5 py-2 text-xs transition-colors",
						value === rate ? "bg-surface-hi text-fg" : "text-fg-muted hover:bg-surface-hi/60",
					)}
				>
					{rate}
				</button>
			))}
		</div>
	);
}
