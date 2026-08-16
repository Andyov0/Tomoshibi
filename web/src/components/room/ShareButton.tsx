import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/hooks/useT";
import type { Phrase } from "@/live/i18n";
import {
	SHARE_QUALITIES,
	type ShareFrameRate,
	type ShareQuality,
	ratesFor,
	rememberFrameRate,
	rememberQuality,
	rememberedFrameRate,
	rememberedQuality,
} from "@/live/room";
import { MonitorOff, MonitorUp } from "lucide-react";
import { useState } from "react";

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
	onStart: (frameRate: ShareFrameRate, quality: ShareQuality) => void;
	onStop: () => void;
}) {
	const t = useT();

	// Before the early return below, and it has to stay there. A hook after a
	// conditional return is called on some renders and not others, and React
	// counts them: the render where sharing first becomes true finds fewer hooks
	// than the one before it and throws. The failure is not subtle — the button
	// crashes at the moment somebody starts sharing — but it is invisible to
	// anything that only renders the component once.
	const [quality, setQuality] = useState<ShareQuality>(rememberedQuality);
	const [frameRate, setFrameRate] = useState<ShareFrameRate>(rememberedFrameRate);

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

	const rates = ratesFor(quality);
	const rate = rates.includes(frameRate) ? frameRate : (rates[rates.length - 1] ?? 30);

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

			<DropdownMenuContent align="center" side="top" className="min-w-56">
				{/* The two settings first, because they are what somebody came to
				    change, and the button that starts the share last — pressing it
				    is the end of the errand rather than the middle of it. */}
				<DropdownMenuLabel>{t("Picture")}</DropdownMenuLabel>

				{SHARE_QUALITIES.map((option) => (
					<DropdownMenuCheckboxItem
						key={option}
						checked={quality === option}
						onSelect={(event) => {
							// Kept open: this is a setting, and closing the menu would
							// make somebody reopen it to do the thing they came for.
							event.preventDefault();
							setQuality(option);
							rememberQuality(option);
						}}
						className="flex-col items-start gap-0"
					>
						<span className="text-fg">{t(QUALITY_LABELS[option].label)}</span>
						<span className="text-fg-muted text-xs">{t(QUALITY_LABELS[option].describes)}</span>
					</DropdownMenuCheckboxItem>
				))}

				{/* Absent for automatic, which chooses the rate as well. A control
				    that did nothing would be a control somebody set and believed. */}
				{quality !== "auto" && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuLabel>{t("Frames a second")}</DropdownMenuLabel>

						<div className="flex flex-wrap gap-1 px-2 pb-1.5">
							{rates.map((option) => (
								<button
									key={option}
									type="button"
									onClick={() => {
										setFrameRate(option);
										rememberFrameRate(option);
									}}
									className={cn(
										"rounded-md border px-2 py-1 text-[12px] tabular-nums transition-colors",
										option === rate
											? "border-tally/50 bg-tally/15 text-fg"
											: "border-border text-fg-muted hover:bg-surface-2 hover:text-fg",
									)}
								>
									{option}
								</button>
							))}
						</div>
					</>
				)}

				<DropdownMenuSeparator />

				<DropdownMenuItem onSelect={() => onStart(rate, quality)} className="gap-2">
					<MonitorUp className="size-4" />
					<span className="text-fg">{t("Share your screen")}</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * The sizes, in what somebody is choosing between rather than in pixels.
 *
 * The resolution is named because whoever is choosing is looking at a display
 * and knows what it is. What is worth saying beside it is the part they cannot
 * see: automatic is the only setting that will quietly send less, and every
 * other one is a promise to send what was asked for.
 */
const QUALITY_LABELS: Record<ShareQuality, { label: Phrase; describes: Phrase }> = {
	auto: { label: "Automatic", describes: "Adjusts to the connection" },
	"1080p": { label: "1080p", describes: "Up to 240 frames a second" },
	"1440p": { label: "1440p", describes: "Up to 120 frames a second" },
	"4k": { label: "4K", describes: "Up to 60 frames a second" },
};

