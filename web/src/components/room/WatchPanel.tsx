import { WatchTab } from "@/components/room/WatchTab";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import type { Room } from "livekit-client";
import { X } from "lucide-react";

/**
 * Watching a video together: a link to paste, and what is playing and coming up.
 *
 * A panel and a button of its own rather than a tab beside the music, which is
 * where it began: the two are different things to reach for -- one plays into
 * the call's sound, the other puts a picture on the stage -- and a tab inside
 * the other's panel was one more press and one more thing to look for.
 */
export function WatchPanel({
	room,
	ready,
	leaving = false,
	onClose,
}: {
	room: Room;
	/** Whether this person can start a show: signed in, on a deployment with a watch gateway. */
	ready: boolean;
	/** Playing its way out, for the exit animation. */
	leaving?: boolean;
	onClose: () => void;
}) {
	const t = useT();
	return (
		<aside
			className={cn(
				"absolute z-20 flex flex-col overflow-hidden border border-border",
				"bg-surface/95 shadow-2xl backdrop-blur-md",
				leaving ? "animate-depart" : "animate-arrive",
				"inset-x-0 bottom-0 h-[70%] rounded-t-2xl",
				"pb-[calc(env(safe-area-inset-bottom)+3.5rem)] sm:pb-0",
				"sm:inset-x-auto sm:right-3 sm:bottom-3 sm:h-[min(34rem,calc(100%-5.5rem))] sm:w-80 sm:rounded-xl",
			)}
		>
			<header className="flex items-center justify-between border-border border-b px-3 py-2">
				<strong className="font-semibold text-[12.5px]">{t("Watch together")}</strong>
				<Button variant="ghost" size="icon" className="size-6" aria-label={t("Close watch together")} onClick={onClose}>
					<X className="size-3.5" />
				</Button>
			</header>
			<WatchTab room={room} ready={ready} />
		</aside>
	);
}
