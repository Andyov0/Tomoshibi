import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SHARE_FRAME_RATES, type ShareFrameRate, share } from "@/live/room";
import type { Room } from "livekit-client";
import { Mic, MicOff, MonitorOff, MonitorUp, PhoneOff, Video, VideoOff } from "lucide-react";
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
export function ControlBar({ room, onLeave }: { room: Room; onLeave: () => void }) {
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
		<footer className="flex shrink-0 items-center justify-center gap-2 border-border border-t bg-surface/60 px-4 py-3">
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
				// Sharing is on when the switch is on, so the lit colour is
				// inverted relative to the others: a lit share button means you
				// are sharing, not that you are able to.
				activeVariant="default"
				onClick={guard(() => share(room, !local.screen, frameRate))}
			>
				{local.screen ? <MonitorOff /> : <MonitorUp />}
			</Toggle>

			<FrameRate value={frameRate} onChange={setFrameRate} disabled={local.screen} />

			<DeviceMenu room={room} />

			<Button variant="danger" size="icon" aria-label="Leave" onClick={onLeave} className="ml-4">
				<PhoneOff />
			</Button>
		</footer>
	);
}

function Toggle({
	on,
	onLabel,
	offLabel,
	onClick,
	children,
	activeVariant = "secondary",
}: {
	on: boolean;
	onLabel: string;
	offLabel: string;
	onClick: () => void;
	children: React.ReactNode;
	activeVariant?: "secondary" | "default";
}) {
	return (
		<Button
			variant={on ? activeVariant : "danger"}
			size="icon"
			aria-label={on ? onLabel : offLabel}
			aria-pressed={on}
			onClick={onClick}
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
