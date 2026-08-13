import { Button } from "@/components/ui/button";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Shown to somebody who is alone.
 *
 * The moment anybody most needs the link to a room is the moment they discover
 * they are the only one in it, and until now that moment offered a view of
 * themselves and nothing else.
 */
export function EmptyRoom() {
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
			<p className="text-fg-muted text-sm">Nobody else is here yet.</p>

			<Button variant="secondary" onClick={copy} className="gap-2">
				{copied ? <Check className="size-4 text-speaking" /> : <Copy className="size-4" />}
				{copied ? "Link copied" : "Copy the link to this room"}
			</Button>
		</div>
	);
}
