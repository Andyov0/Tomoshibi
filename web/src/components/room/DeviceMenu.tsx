import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/hooks/useT";
import { deviceFailed } from "@/live/notices";
import type { Room } from "livekit-client";
import { ChevronUp } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Device pickers.
 *
 * Noise suppression, echo cancellation, and gain control are left to the
 * browser's own audio pipeline, which every other call app relies on when it is
 * not shipping a model of its own. They are not exposed as switches because the
 * defaults are right for a meeting, and the one case where they are wrong
 * (playing music) is better served by sharing a tab with its audio.
 */
export function DeviceMenu({ room }: { room: Room }) {
	const t = useT();

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

				<DropdownMenuSeparator />
				<DropdownMenuLabel>{t("Camera")}</DropdownMenuLabel>
				<Devices room={room} kind="videoinput" />
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

	// The tick moves at once, because a menu that waits on the device before
	// acknowledging the press feels broken. So it has to move back when the
	// device will not come: the switch was once left unawaited, and a device that
	// failed to start left the menu ticking one thing while the call used
	// another, with nothing said about either.
	const select = async (deviceId: string) => {
		const before = active;
		setActive(deviceId);

		try {
			// A false answer is the SDK saying some track did not take the new
			// device, which is the same failure without an error to carry it.
			if (!(await room.switchActiveDevice(kind, deviceId))) throw new Error("not switched");
		} catch (err) {
			setActive(before);
			if (kind !== "audiooutput") deviceFailed(kind === "audioinput" ? "microphone" : "camera", err);
		}
	};

	return (
		<>
			{devices.map((device, index) => (
				<DropdownMenuCheckboxItem
					key={device.deviceId}
					checked={device.deviceId === active}
					onCheckedChange={() => void select(device.deviceId)}
				>
					{/* Labels are empty until permission is granted, and a blank
					    row is worse than a generic one. */}
					{device.label || t("Device {number}", { number: index + 1 })}
				</DropdownMenuCheckboxItem>
			))}
		</>
	);
}
