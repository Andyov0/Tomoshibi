import { SelfView } from "@/components/room/SelfView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { devicesAvailable, insecureReason } from "@/live/context";
import { ShieldAlert } from "lucide-react";
import { type LocalVideoTrack, createLocalVideoTrack } from "livekit-client";
import { Mic, MicOff, Video, VideoOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const NAME_KEY = "meet-live.name";
const DEVICES_KEY = "meet-live.devices";

export interface Choices {
	name: string;
	camera: boolean;
	microphone: boolean;
}

/**
 * Device check before entering a room.
 *
 * The camera starts off and the microphone starts on, and both remember what was
 * chosen last time. Defaulting the camera on means the light comes on before
 * anybody has decided to be seen, which is the wrong way round for somebody
 * joining late or from somewhere they would rather not show.
 */
export function PreJoin({ onJoin }: { onJoin: (choices: Choices) => void }) {
	// Checked before anything reaches for a device, so the page explains why it
	// cannot rather than failing on a property that is simply not there.
	if (!devicesAvailable()) {
		return <Unavailable reason={insecureReason()} />;
	}

	return <Form onJoin={onJoin} />;
}

function Form({ onJoin }: { onJoin: (choices: Choices) => void }) {
	const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
	const [devices, setDevices] = useState(remembered);
	const [track, setTrack] = useState<LocalVideoTrack>();
	const [joining, setJoining] = useState(false);

	// Held in a ref as well, so the cleanup below stops whatever is current
	// rather than whatever was current when the effect last ran.
	const current = useRef<LocalVideoTrack>();

	useEffect(() => {
		let live = true;

		if (!devices.camera) {
			current.current?.stop();
			current.current = undefined;
			setTrack(undefined);
			return;
		}

		createLocalVideoTrack()
			.then((made) => {
				if (!live) {
					made.stop();
					return;
				}
				current.current = made;
				setTrack(made);
			})
			.catch(() => {
				// A refused camera is an answer. The switch falls back to off so
				// the preview and the control agree.
				if (live) setDevices((held) => ({ ...held, camera: false }));
			});

		return () => {
			live = false;
		};
	}, [devices.camera]);

	// Stopped only when the screen goes away for good. The track itself is handed
	// to the room on join, so tearing it down on every render would drop the
	// preview and prompt again a moment later.
	useEffect(() => () => current.current?.stop(), []);

	const submit = () => {
		const trimmed = name.trim();
		if (!trimmed || joining) return;

		localStorage.setItem(NAME_KEY, trimmed);
		localStorage.setItem(DEVICES_KEY, JSON.stringify(devices));

		setJoining(true);
		onJoin({ name: trimmed, ...devices });
	};

	return (
		<main className="grid min-h-full place-items-center p-6">
			<div className="w-full max-w-md space-y-6">
				<header className="space-y-1 text-center">
					<h1 className="font-semibold text-2xl tracking-tight">Ready to join?</h1>
					<p className="text-fg-muted text-sm">Check your camera and microphone first.</p>
				</header>

				<SelfView track={track} />

				<div className="flex justify-center gap-2">
					<Button
						variant={devices.microphone ? "secondary" : "danger"}
						size="icon"
						aria-label={devices.microphone ? "Mute microphone" : "Unmute microphone"}
						aria-pressed={devices.microphone}
						onClick={() => setDevices((held) => ({ ...held, microphone: !held.microphone }))}
					>
						{devices.microphone ? <Mic /> : <MicOff />}
					</Button>
					<Button
						variant={devices.camera ? "secondary" : "danger"}
						size="icon"
						aria-label={devices.camera ? "Turn camera off" : "Turn camera on"}
						aria-pressed={devices.camera}
						onClick={() => setDevices((held) => ({ ...held, camera: !held.camera }))}
					>
						{devices.camera ? <Video /> : <VideoOff />}
					</Button>
				</div>

				<form
					className="space-y-3"
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<Input
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder="Your name"
						aria-label="Your name"
						autoFocus
						maxLength={40}
					/>
					<Button type="submit" size="lg" className="w-full" disabled={!name.trim() || joining}>
						{joining ? "Joining…" : "Join"}
					</Button>
				</form>
			</div>
		</main>
	);
}

/**
 * Why this page cannot open a camera.
 *
 * A dead end rather than a warning, because there is nothing to try: the page
 * has to be loaded from somewhere else before any of this works.
 */
function Unavailable({ reason }: { reason: string }) {
	return (
		<main className="grid min-h-full place-items-center p-6">
			<div className="w-full max-w-md space-y-4 text-center">
				<ShieldAlert className="mx-auto size-10 text-fg-muted" />
				<h1 className="font-semibold text-2xl tracking-tight">Cannot reach your devices</h1>
				<p className="text-fg-muted text-sm">{reason}</p>
			</div>
		</main>
	);
}

/** What was chosen last time, or the defaults on a first visit. */
function remembered(): { camera: boolean; microphone: boolean } {
	const fallback = { camera: false, microphone: true };

	try {
		const stored = localStorage.getItem(DEVICES_KEY);
		if (!stored) return fallback;

		const parsed = JSON.parse(stored) as Partial<typeof fallback>;
		return {
			camera: parsed.camera ?? fallback.camera,
			microphone: parsed.microphone ?? fallback.microphone,
		};
	} catch {
		return fallback;
	}
}
