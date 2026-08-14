import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/hooks/useT";
import type { Phrase } from "@/live/i18n";
import { SHARE_FRAME_RATES, type ShareFrameRate } from "@/live/room";
import { MonitorOff, MonitorUp } from "lucide-react";

/**
 * Starting and stopping a screen share.
 *
 * The choice of what the screen is for lives inside this button rather than
 * beside it. As a control of its own it was a bare pair of numbers sitting among
 * the microphone and the camera, and it could not answer either of the two
 * questions anybody would ask of it: whose setting is this, and which picture
 * does it govern. Nothing about a capsule reading "30 | 60" says screen, and
 * nothing says sending.
 *
 * Placed here, both answers are structural rather than written down. It is under
 * the screen button, so it is about the screen; it is on the controls for one's
 * own devices, so it is about what is being sent. Neither fact needs a label,
 * and a label would not have made them true.
 *
 * It also puts the question where the answer is known. Asked in advance it is a
 * setting to remember and get wrong later; asked at the moment of sharing, it is
 * the same question as which window to share, and somebody about to share a
 * terminal knows they are about to share a terminal.
 */
export function ShareButton({
	sharing,
	onStart,
	onStop,
}: {
	sharing: boolean;
	/** Begin, in the manner chosen. */
	onStart: (frameRate: ShareFrameRate) => void;
	onStop: () => void;
}) {
	const t = useT();

	// Stopping is not a choice, so while a share is running the button is a
	// button. Opening a menu to answer a question that has already been answered
	// is a step somebody has to read before they can dismiss it.
	if (sharing) {
		return (
			<Button
				variant="default"
				size="round"
				aria-label={t("Stop sharing")}
				aria-pressed
				onClick={onStop}
			>
				<MonitorOff />
			</Button>
		);
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="secondary"
					size="round"
					aria-label={t("Share your screen")}
					aria-pressed={false}
					className="text-fg-muted"
				>
					<MonitorUp />
				</Button>
			</DropdownMenuTrigger>

			<DropdownMenuContent align="center" side="top">
				<DropdownMenuLabel>{t("Share your screen")}</DropdownMenuLabel>

				{SHARE_FRAME_RATES.map((rate) => (
					<DropdownMenuItem
						key={rate}
						onSelect={() => onStart(rate)}
						className="flex-col items-start gap-0"
					>
						<span className="text-fg">{t(SHARE_INTENT[rate].label)}</span>
						{/* What each one is good for, rather than what it does to the
						    encoder. The frame rate is the mechanism; the kind of
						    picture is the question being asked. */}
						<span className="text-fg-muted text-xs">{t(SHARE_INTENT[rate].describes)}</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * The two kinds of screen, in the words of somebody about to share one.
 *
 * Named for the picture rather than for the number, because the number is not
 * the choice: a share of a terminal and a share of a video want opposite answers
 * to everything that follows, and the frame rate is only the first of them.
 */
const SHARE_INTENT: Record<ShareFrameRate, { label: Phrase; describes: Phrase }> = {
	30: { label: "Sharper text", describes: "Code, documents, slides" },
	60: { label: "Smoother motion", describes: "Video, animation, a demonstration" },
};
