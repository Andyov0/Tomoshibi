import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="round" aria-label="Devices">
					<ChevronUp />
				</Button>
			</DropdownMenuTrigger>

			<DropdownMenuContent align="center" side="top">
				<DropdownMenuLabel>Microphone</DropdownMenuLabel>
				<Devices room={room} kind="audioinput" />

				<DropdownMenuSeparator />
				<DropdownMenuLabel>Camera</DropdownMenuLabel>
				<Devices room={room} kind="videoinput" />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function Devices({ room, kind }: { room: Room; kind: MediaDeviceKind }) {
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
		return <DropdownMenuLabel>No devices found</DropdownMenuLabel>;
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
					{device.label || `Device ${index + 1}`}
				</DropdownMenuCheckboxItem>
			))}
		</>
	);
}
