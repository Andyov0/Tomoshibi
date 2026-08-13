import { AVATAR_COLOURS, avatarSeed } from "@/live/avatar";
import { cn } from "@/lib/utils";
import BoringAvatar from "boring-avatars";

/**
 * Stands in for a participant with no picture.
 *
 * Sized as a share of its tile rather than in pixels, so one component covers a
 * full-size grid cell and a thumbnail in the filmstrip without either being
 * told which it is.
 */
export function Avatar({ identity, className }: { identity: string; className?: string }) {
	return (
		<div className={cn("aspect-square w-[34%] max-w-24 min-w-8", className)}>
			<BoringAvatar
				name={avatarSeed(identity)}
				variant="marble"
				colors={[...AVATAR_COLOURS]}
				size="100%"
			/>
		</div>
	);
}
