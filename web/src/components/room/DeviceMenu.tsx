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
import { LOCALES, LOCALE_NAMES, locale, setLocale, subscribe } from "@/live/i18n";
import type { Room } from "livekit-client";
import { ChevronUp } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

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

				<DropdownMenuSeparator />
				<DropdownMenuLabel>{t("Language")}</DropdownMenuLabel>
				<Languages />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * Which language the interface speaks.
 *
 * Here rather than on the island, because a language is chosen once and a call
 * has six controls already. Each is written in itself and never translated: the
 * person reading this list is the one person who may not read the language it is
 * currently in.
 */
function Languages() {
	const current = useSyncExternalStore(subscribe, locale, locale);

	return (
		<>
			{LOCALES.map((candidate) => (
				<DropdownMenuCheckboxItem
					key={candidate}
					checked={candidate === current}
					onCheckedChange={() => setLocale(candidate)}
				>
					{LOCALE_NAMES[candidate]}
				</DropdownMenuCheckboxItem>
			))}
		</>
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
