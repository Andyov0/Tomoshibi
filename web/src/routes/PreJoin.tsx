import { LanguagePicker } from "@/components/room/LanguagePicker";
import { deployment } from "@/live/api";
import { SelfView } from "@/components/room/SelfView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RoomBar } from "@/components/room/RoomBar";
import { devicesAvailable, insecureReason } from "@/live/context";
import { Phrased, useT } from "@/hooks/useT";
import { parseName } from "@/live/name";
import { remember } from "@/live/remember";
import { KeyRound, ShieldAlert } from "lucide-react";
import { type LocalVideoTrack, createLocalVideoTrack } from "livekit-client";
import { Mic, MicOff, Video, VideoOff } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

/*
 * The keys below still say the name this was called before.
 *
 * Deliberate, and not an oversight to tidy. They are what a browser already has
 * written down: a display name, a device choice, a language, an identity that
 * keeps somebody the same person across a reload. Renaming them renames nothing
 * — it abandons all of it, and everybody using this finds themselves nameless
 * and back in English on the morning after a deployment.
 */
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
			<Source />
		</main>
	);
}

/**
 * Where the code running this can be read.
 *
 * An obligation rather than a courtesy, and one that only a page can discharge.
 * This is licensed under the AGPL, whose thirteenth section says that offering
 * people the use of a program over a network obliges the operator to offer them
 * its source — and everybody being offered the use of this one arrives here.
 *
 * The address comes from the server because a deployment running a changed copy
 * owes its visitors that copy rather than this one. Where a server says nothing,
 * nothing is drawn: an offer of somebody else's source is worse than none, since
 * it looks discharged.
 */
function Source() {
	const [source, setSource] = useState("");

	useEffect(() => {
		let live = true;

		void deployment().then((said) => {
			if (live) setSource(said.source);
		});

		return () => {
			live = false;
		};
	}, []);

	if (!source) return null;

	return (
		<a
			href={source}
			target="_blank"
			rel="noreferrer"
			className="absolute inset-x-0 bottom-3 text-center text-[11px] text-fg-muted/60 transition-colors hover:text-fg-muted"
		>
			{/* Not translated, and not an oversight. It is the name of the licence
			    this is under, which is the same string in every language, and the
			    word beside it is what the link goes to. */}
			AGPL-3.0 · source
		</a>
	);
}

function Form({ room, onRoomChange, onJoin }: PreJoinProps) {
	const t = useT();
	const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
	const [secret, setSecret] = useState("");
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

	/*
	 * Two ways in, and one of them is not drawn.
	 *
	 * The field below is the one this teaches, because a field is the only shape
	 * a password manager can see — the whole reason nobody could remember their
	 * passphrase is that it used to be the half of this one after a hash, which
	 * is invisible to every manager ever written.
	 *
	 * `Alice#secret` still works, and goes on working without being advertised.
	 * It is the form this application taught everybody who has used it, and a
	 * syntax that quietly stops being accepted is worse than one that is no
	 * longer mentioned. The field wins where both are filled, since it is the
	 * one somebody can see.
	 */
	const { name: display, passphrase: written } = parseName(name);
	const passphrase = secret || written;

	const submit = () => {
		if (!display || joining) return;

		// The name is written down here; the passphrase is offered to the
		// browser instead. Local storage is shared with every tab on this origin
		// and outlives the session, which is no place for a credential — and the
		// password manager is a better one than this application could build.
		localStorage.setItem(NAME_KEY, display);
		localStorage.setItem(DEVICES_KEY, JSON.stringify(devices));
		void remember(display, passphrase);

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
						// Named for the manager rather than for this form. It is
						// what a stored credential is filed under, and what makes
						// the field below fill itself alongside it.
						autoComplete="username"
						autoFocus
						maxLength={80}
					/>

					<Input
						type="password"
						value={secret}
						onChange={(event) => setSecret(event.target.value)}
						placeholder={t("Passphrase (optional)")}
						aria-label={t("Passphrase (optional)")}
						autoComplete="current-password"
						maxLength={200}
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
							{t("A passphrase signs your name, so nobody else can appear under it.")}
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
