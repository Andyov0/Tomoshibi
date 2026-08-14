import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import type { Who } from "./api";

/** The panels, in the order somebody works through them. */
export const PANELS = ["Now", "Rooms", "Health", "Runtime", "Audit"] as const;
export type Panel = (typeof PANELS)[number];

/**
 * The frame the management pages sit in.
 *
 * English only, and not by omission. Its reader is whoever runs this
 * deployment, the same person the startup log and the unbuilt-client page are
 * written for. It is also mostly technical nouns — a codec name, a degradation
 * preference, a socket option — and a page that translates the sentences while
 * leaving those in place reads worse than one that translates nothing.
 */
export function Shell({
	who,
	panel,
	onPanel,
	onSignOut,
	children,
}: {
	who: Who;
	panel: Panel;
	onPanel: (panel: Panel) => void;
	onSignOut: () => void;
	children: ReactNode;
}) {
	return (
		<div className="flex min-h-full flex-col bg-bg text-fg">
			<header className="flex items-center gap-4 border-border border-b px-5 py-3">
				<span className="font-semibold text-sm">Management</span>

				<nav className="flex items-center gap-1">
					{PANELS.map((one) => (
						<button
							key={one}
							type="button"
							onClick={() => onPanel(one)}
							aria-current={one === panel ? "page" : undefined}
							className={cn(
								"rounded-md px-2.5 py-1 text-[13px] transition-colors",
								one === panel
									? "bg-surface-hi text-fg"
									: "text-fg-muted hover:bg-surface hover:text-fg",
							)}
						>
							{one}
						</button>
					))}
				</nav>

				<div className="ml-auto flex items-center gap-3 text-fg-muted text-xs">
					{/* The signature rather than the name: a name is whatever the
					    configuration file says, and the signature is what was
					    actually proved. */}
					<span className="readout">
						{who.name ? `${who.name} · ` : ""}
						{who.trip}
					</span>
					{!who.can.includes("moderate") && (
						<span className="rounded border border-border px-1.5 py-0.5">watching only</span>
					)}
					<Button variant="ghost" size="sm" onClick={onSignOut}>
						Sign out
					</Button>
				</div>
			</header>

			<main className="flex-1 p-5">{children}</main>
		</div>
	);
}

/** A titled block, which every panel is made of. */
export function Card({
	title,
	note,
	children,
	className,
}: {
	title: string;
	note?: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section className={cn("rounded-lg border border-border bg-surface", className)}>
			<header className="flex items-baseline gap-3 border-border border-b px-4 py-2.5">
				<h2 className="font-medium text-[13px]">{title}</h2>
				{note && <p className="text-fg-muted text-xs">{note}</p>}
			</header>
			{children}
		</section>
	);
}

/** Nothing to show, said in a way that distinguishes empty from broken. */
export function Empty({ children }: { children: ReactNode }) {
	return <p className="px-4 py-6 text-center text-fg-muted text-xs">{children}</p>;
}

/** Something went wrong, kept out of the way of the figures. */
export function Failed({ children }: { children: ReactNode }) {
	return (
		<p className="border-danger/40 border-b bg-danger/10 px-4 py-2 text-danger text-xs">
			{children}
		</p>
	);
}
