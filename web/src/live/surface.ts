import { tripOf } from "@/live/name";
import type { TrackReferenceOrPlaceholder } from "@livekit/components-core";
import { type Participant, Track } from "livekit-client";

/**
 * One picture in the layout.
 *
 * The unit is a picture rather than a person, because somebody sharing their
 * screen while their camera is on contributes two. That distinction is why every
 * layout takes surfaces and never participants.
 *
 * Shaped as the library's own track reference, so it can be handed straight to
 * the components that know how to render one. A placeholder reference is a
 * participant with no publication for that source yet, which is exactly what a
 * camera that is off looks like.
 */
export interface Surface {
	/** Stable across renders, so React keeps the same tile mounted. */
	id: string;
	/** What the renderer needs, in the shape it expects. */
	track: TrackReferenceOrPlaceholder;
	kind: "camera" | "screen";
	/** True for our own pictures, which need mirroring and no audio. */
	local: boolean;
}

/** Who this surface belongs to. */
export function owner(surface: Surface): Participant {
	return surface.track.participant;
}

/** What the tile should be labelled. */
export function label(surface: Surface): string {
	const participant = owner(surface);
	const name = participant.name || participant.identity;

	return surface.kind === "screen" ? `${name} (screen)` : name;
}

/**
 * The signature this surface's owner carries, if they signed their name.
 *
 * Read out of the identity, which is signed into their token and enforced by the
 * media server, so it is a fact about them rather than something they told us.
 */
export function signature(surface: Surface): string | undefined {
	return tripOf(owner(surface).identity);
}

/**
 * Derive the surfaces for a roster.
 *
 * A camera surface exists for every participant whether or not their camera is
 * on, because presence is being in the room rather than being visible: somebody
 * fully muted still belongs in the grid. A screen surface exists only while
 * something is being shared.
 */
export function surfaces(participants: Participant[], localIdentity: string): Surface[] {
	const found: Surface[] = [];

	for (const participant of participants) {
		const local = participant.identity === localIdentity;

		found.push({
			id: `${participant.identity}/camera`,
			kind: "camera",
			local,
			track: {
				participant,
				source: Track.Source.Camera,
				publication: participant.getTrackPublication(Track.Source.Camera),
			},
		});

		const screen = participant.getTrackPublication(Track.Source.ScreenShare);
		if (screen) {
			found.push({
				id: `${participant.identity}/screen`,
				kind: "screen",
				local,
				track: { participant, source: Track.Source.ScreenShare, publication: screen },
			});
		}
	}

	return found;
}
