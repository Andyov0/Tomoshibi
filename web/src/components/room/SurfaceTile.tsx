import { type Surface, label, owner, signature } from "@/live/surface";
import type { TrackReference } from "@livekit/components-core";
import { VideoTrack } from "@livekit/components-react";
import { VideoOff } from "lucide-react";
import { Tile } from "./Tile";

/**
 * One picture in the layout.
 *
 * Rendering goes through the library's own component rather than attaching the
 * track by hand, because subscription is tied to the element: it subscribes when
 * the element is on screen, unsubscribes when it is not, and picks the simulcast
 * layer that matches the element's size. Doing that by hand meant fighting it
 * for control and getting neither behaviour reliably.
 */
export function SurfaceTile({
	surface,
	subscribed = true,
	unverified = false,
	onDoubleClick,
}: {
	surface: Surface;
	subscribed?: boolean;
	unverified?: boolean;
	onDoubleClick?: () => void;
}) {
	const participant = owner(surface);
	const camera = surface.kind === "camera";
	// A placeholder reference is a camera that is off, which is a picture there
	// is nothing to render for. Narrowing here rather than asserting below keeps
	// the two conditions from drifting apart.
	const publication = surface.track.publication;
	const showing = subscribed && publication !== undefined && !publication.isMuted;
	const track = surface.track as TrackReference;

	// A face is fine to crop at the edges and looks wrong letterboxed, so a
	// camera fills its tile. A shared screen is the opposite: cropping hides
	// whatever was at the edge, which may be the thing being pointed at, so it is
	// shown whole with bars when the shapes disagree.
	const fit = camera ? "object-cover" : "object-contain";

	// Mirrored only for our own camera. An unmirrored view of yourself makes
	// reaching for something on screen feel backwards; everybody else sees the
	// unmirrored picture, and a mirrored screen share would be unreadable.
	const mirror = surface.local && camera;

	return (
		<Tile
			label={surface.local ? `${label(surface)} (you)` : label(surface)}
			signature={camera ? signature(surface) : undefined}
			unverified={camera && unverified}
			speaking={participant.isSpeaking && camera}
			muted={camera && !participant.isMicrophoneEnabled}
			onDoubleClick={onDoubleClick}
		>
			{showing ? (
				<VideoTrack
					trackRef={track}
					manageSubscription
					className={`absolute inset-0 size-full ${fit} ${mirror ? "-scale-x-100" : ""}`}
				/>
			) : (
				<div className="absolute inset-0 grid place-items-center bg-surface text-fg-muted">
					<VideoOff className="size-7" />
				</div>
			)}
		</Tile>
	);
}
