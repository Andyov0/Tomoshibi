import { LanguagePicker } from "@/components/room/LanguagePicker";
import { SelfView } from "@/components/room/SelfView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RoomBar } from "@/components/room/RoomBar";
import { devicesAvailable, insecureReason } from "@/live/context";
import { Phrased, useT } from "@/hooks/useT";
import { parseName } from "@/live/name";
import { KeyRound, ShieldAlert } from "lucide-react";
import { type LocalVideoTrack, createLocalVideoTrack } from "livekit-client";
import { Mic, MicOff, Video, VideoOff } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

const NAME_KEY = "meet-live.name";
const DEVICES_KEY = "meet-live.devices";

export interface Choices {
	name: string;
	/** Never leaves this tab except in the join request. */
	passphrase: string;
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
export interface PreJoinProps {
	room: string;
	onRoomChange: (room: string) => void;
	onJoin: (choices: Choices) => void;
}

export function PreJoin({ room, onRoomChange, onJoin }: PreJoinProps) {
	// Checked before anything reaches for a device, so the page explains why it
	// cannot rather than failing on a property that is simply not there.
	if (!devicesAvailable()) {
		return <Unavailable reason={insecureReason()} />;
	}

	return <Form room={room} onRoomChange={onRoomChange} onJoin={onJoin} />;
}

/**
 * The page before a call, whichever of its two states it is in.
 *
 * The language picker sits above both. It is needed most on the state that
 * cannot be joined from: somebody who lands on the dead end in a language they
 * do not read has no way to find out why, and no button that would tell them.
 */
function Page({ children }: { children: ReactNode }) {
	return (
		<main className="relative grid min-h-full place-items-center p-6">
			<div className="absolute top-4 right-4">
				<LanguagePicker />
			</div>
			{children}
		</main>
	);
}

function Form({ room, onRoomChange, onJoin }: PreJoinProps) {
	const t = useT();
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

	const { name: display, passphrase } = parseName(name);

	const submit = () => {
		if (!display || joining) return;

		// Only the name is remembered. A passphrase is a secret, and local
		// storage is shared with every tab on this origin and outlives the
		// session; it is typed again or not used.
		localStorage.setItem(NAME_KEY, display);
		localStorage.setItem(DEVICES_KEY, JSON.stringify(devices));

		setJoining(true);
		onJoin({ name: display, passphrase, ...devices });
	};

	return (
		<Page>
			<div className="w-full max-w-md space-y-6">
				<header className="space-y-1 text-center">
					<h1 className="font-semibold text-2xl tracking-tight">{t("Ready to join?")}</h1>
					<p className="text-fg-muted text-sm">{t("Check your camera and microphone first.")}</p>
				</header>

				<RoomBar room={room} onChange={onRoomChange} />

				<SelfView track={track} />

				<div className="flex justify-center gap-2">
					<Button
						variant={devices.microphone ? "secondary" : "danger"}
						size="icon"
						aria-label={devices.microphone ? t("Mute microphone") : t("Unmute microphone")}
						aria-pressed={devices.microphone}
						onClick={() => setDevices((held) => ({ ...held, microphone: !held.microphone }))}
					>
						{devices.microphone ? <Mic /> : <MicOff />}
					</Button>
					<Button
						variant={devices.camera ? "secondary" : "danger"}
						size="icon"
						aria-label={devices.camera ? t("Turn camera off") : t("Turn camera on")}
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
						placeholder={t("Your name")}
						aria-label={t("Your name")}
						autoFocus
						maxLength={80}
					/>

					{passphrase ? (
						<p className="flex items-center justify-center gap-1.5 text-fg-muted text-xs">
							<KeyRound className="size-3" />
							<Phrased
								phrase="Joining as {name} with a signature only you can produce"
								values={{
									name: <strong className="text-fg">{display || "?"}</strong>,
								}}
							/>
						</p>
					) : (
						<p className="text-center text-fg-muted text-xs">
							<Phrased
								phrase="Add {hash} and a passphrase to sign your name, so nobody else can appear under it."
								values={{ hash: <code className="text-fg">#</code> }}
							/>
						</p>
					)}

					<Button type="submit" size="lg" className="w-full" disabled={!display || joining}>
						{joining ? t("Joining…") : t("Join")}
					</Button>
				</form>
			</div>
		</Page>
	);
}

/**
 * Why this page cannot open a camera.
 *
 * A dead end rather than a warning, because there is nothing to try: the page
 * has to be loaded from somewhere else before any of this works.
 */
function Unavailable({ reason }: { reason: string }) {
	const t = useT();

	return (
		<Page>
			<div className="w-full max-w-md space-y-4 text-center">
				<ShieldAlert className="mx-auto size-10 text-fg-muted" />
				<h1 className="font-semibold text-2xl tracking-tight">{t("Cannot reach your devices")}</h1>
				<p className="text-fg-muted text-sm">{reason}</p>
			</div>
		</Page>
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
