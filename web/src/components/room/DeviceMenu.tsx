import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useBlur } from "@/hooks/useBlur";
import type { Placement } from "@/live/controls";
import { useT } from "@/hooks/useT";
import { type Room, supportsAudioOutputSelection } from "livekit-client";
import { ChevronUp, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Device pickers.
 *
 * Noise suppression, echo cancellation, and gain control are left to the
 * browser's own audio pipeline, which every other call app relies on when it is
 * not shipping a model of its own. They are not exposed as switches because the
 * defaults are right for a meeting, and the one case where they are wrong
 * (playing music) is better served by sharing a tab with its audio.
 *
 * Where sound comes out is here too, and was not. Somebody who plugs in
 * headphones part-way through a call had no way to move the call onto them from
 * inside the application: the only route was to leave, change the machine's
 * setting, and come back. Offered only where the browser can act on it — Safari
 * cannot, and a control that silently does nothing is worse than its absence.
 */
export function DeviceMenu({
	room,
	where,
	onPlace,
}: { room: Room; where: Placement; onPlace: (where: Placement) => void }) {
	const t = useT();
	const background = useBlur(room);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="round" aria-label={t("Devices")}>
					<ChevronUp />
				</Button>
			</DropdownMenuTrigger>

			<DropdownMenuContent align="center" side="top">
				<DropdownMenuLabel>{t("Microphone")}</DropdownMenuLabel>
				<Devices room={room} kind="audioinput" />

				{supportsAudioOutputSelection() && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuLabel>{t("Speakers")}</DropdownMenuLabel>
						<Devices room={room} kind="audiooutput" />
					</>
				)}

				<DropdownMenuSeparator />
				<DropdownMenuLabel>{t("Camera")}</DropdownMenuLabel>
				<Devices room={room} kind="videoinput" />

				{/* Where the controls themselves are, which is the one setting in
				    this menu that is not about a device. It is here because this
				    is the only menu in the room, and because a control that
				    covers what somebody is looking at has to be adjustable from
				    the control itself — anywhere else is a setting nobody finds
				    while being annoyed by the thing it fixes. */}
				<DropdownMenuSeparator />
				<DropdownMenuLabel>{t("Controls")}</DropdownMenuLabel>

				{(
					[
						["always", t("Always shown")],
						["idle", t("Hide when nothing is happening")],
						["side", t("At the side")],
					] as const
				).map(([which, said]) => (
					<DropdownMenuCheckboxItem
						key={which}
						checked={where === which}
						onCheckedChange={() => onPlace(which)}
					>
						{said}
					</DropdownMenuCheckboxItem>
				))}

				{/* Under the camera, because it is a property of the picture and
				    not a thing of its own. Absent entirely where the browser
				    cannot do it: an option that explains why it does not work is
				    an option somebody reads once and resents. */}
				{background.possible && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuLabel>{t("Background")}</DropdownMenuLabel>

						<DropdownMenuCheckboxItem
							checked={background.on}
							disabled={background.busy}
							onSelect={(event) => {
								// Kept open. Turning this on takes a moment the first
								// time — the model has to be fetched — and a menu that
								// closes over that looks like a press that did nothing.
								event.preventDefault();
							}}
							onCheckedChange={() => void background.toggle()}
						>
							{background.busy && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
							{background.on ? t("Blurred") : t("Not blurred")}
						</DropdownMenuCheckboxItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function Devices({ room, kind }: { room: Room; kind: MediaDeviceKind }) {
	const t = useT();
	const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
	const [active, setActive] = useState<string | undefined>(() => room.getActiveDevice(kind));

	useEffect(() => {
		let live = true;

		const refresh = () => {
			navigator.mediaDevices
				.enumerateDevices()
				.then((all) => {
					if (live) setDevices(all.filter((device) => device.kind === kind));
				})
				.catch(() => {
					// Enumeration fails before permission is granted, which is a
					// state the empty list already describes.
				});
		};

		refresh();
		navigator.mediaDevices.addEventListener("devicechange", refresh);

		return () => {
			live = false;
			navigator.mediaDevices.removeEventListener("devicechange", refresh);
		};
	}, [kind]);

	if (devices.length === 0) {
		return <DropdownMenuLabel>{t("No devices found")}</DropdownMenuLabel>;
	}

	const select = (deviceId: string) => {
		setActive(deviceId);
		void room.switchActiveDevice(kind, deviceId);
	};

	return (
		<>
			{devices.map((device, index) => (
				<DropdownMenuCheckboxItem
					key={device.deviceId}
					checked={device.deviceId === active}
					onCheckedChange={() => select(device.deviceId)}
				>
					{/* Labels are empty until permission is granted, and a blank
					    row is worse than a generic one. */}
					{device.label || t("Device {number}", { number: index + 1 })}
				</DropdownMenuCheckboxItem>
			))}
		</>
	);
}
