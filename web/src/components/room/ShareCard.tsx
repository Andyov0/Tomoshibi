import { Button } from "@/components/ui/button";
import { MonitorUp } from "lucide-react";
import { Tile } from "./Tile";

/**
 * Stands in for a screen share that is not on the stage.
 *
 * A 1080p desktop scaled into a grid cell is unreadable, so subscribing to it
 * would spend the bandwidth and deliver nothing. The card says who is sharing
 * and offers the one useful action, which is to make it big.
 */
export function ShareCard({ label, onOpen }: { label: string; onOpen: () => void }) {
	return (
		<Tile label={label} onDoubleClick={onOpen}>
			<div className="absolute inset-0 grid place-items-center bg-surface-hi/40">
				<div className="flex flex-col items-center gap-3 px-4 text-center">
					<MonitorUp className="size-8 text-fg-muted" />
					<p className="text-fg-muted text-sm">{label} is sharing</p>
					<Button size="sm" variant="secondary" onClick={onOpen}>
						View
					</Button>
				</div>
			</div>
		</Tile>
	);
}
