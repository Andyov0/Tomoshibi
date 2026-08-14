import { useT } from "@/hooks/useT";
import { Button } from "@/components/ui/button";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Shown to somebody who is alone.
 *
 * The moment anybody most needs the link to a room is the moment they discover
 * they are the only one in it, and until now that moment offered a view of
 * themselves and nothing else.
 *
 * The button and nothing else. It said so in a sentence first, which was a
 * caption on a fact the screen was already making plain — one picture, and it is
 * yours. What somebody wants at that moment is the address, and a button that
 * names what it does needs no line above it explaining the room.
 *
 * It goes when a second person arrives, which is not when the address stops
 * being wanted: the room's own menu carries it from then on.
 */
export function EmptyRoom() {
	const t = useT();
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1600);
		return () => clearTimeout(timer);
	}, [copied]);

	const copy = () => {
		// The address bar's own text rather than one assembled here, which is
		// right until the first deployment behind a path or a different port.
		navigator.clipboard
			.writeText(window.location.href)
			.then(() => setCopied(true))
			.catch(() => setCopied(false));
	};

	return (
		<div className="flex flex-col items-center gap-3 text-center">
			<Button variant="secondary" onClick={copy} className="gap-2">
				{copied ? <Check className="size-4 text-speaking" /> : <Copy className="size-4" />}
				{copied ? t("Link copied") : t("Copy the link to this room")}
			</Button>
		</div>
	);
}
