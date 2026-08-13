import { VideoOff } from "lucide-react";
import type { LocalVideoTrack } from "livekit-client";
import { useEffect, useRef } from "react";

/**
 * The camera preview on the pre-join screen.
 *
 * Mirrored, because an unmirrored view of yourself makes reaching for something
 * on screen feel backwards. Everybody else sees the unmirrored picture.
 */
export function SelfView({ track }: { track: LocalVideoTrack | undefined }) {
	const ref = useRef<HTMLVideoElement>(null);

	useEffect(() => {
		const element = ref.current;
		if (!element || !track) return;

		track.attach(element);
		return () => {
			track.detach(element);
		};
	}, [track]);

	return (
		<div className="relative aspect-video w-full overflow-hidden rounded-tile bg-surface">
			<video
				ref={ref}
				autoPlay
				playsInline
				muted
				className="-scale-x-100 absolute inset-0 size-full object-cover"
			/>

			{!track && (
				<div className="absolute inset-0 grid place-items-center text-fg-muted">
					<VideoOff className="size-8" />
				</div>
			)}
		</div>
	);
}
