import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Activity, Clock, LayoutGrid, ScrollText, Server, Users, UsersRound } from "lucide-react";
import type { ReactNode } from "react";
import type { Who } from "./api";
import { rate } from "./units";

/** The panels, in the order somebody works through them. */
export const PANELS = ["Now", "Rooms", "Accounts", "Relays", "Admins", "Runtime", "Audit"] as const;
export type Panel = (typeof PANELS)[number];

const ICONS: Record<Panel, typeof Activity> = {
	Now: Activity,
	Rooms: LayoutGrid,
	Accounts: UsersRound,
	Relays: Server,
	Admins: Users,
	Runtime: ScrollText,
	Audit: Clock,
};

/**
 * The frame the management pages sit in.
 *
 * A rail down the side on a laptop and a row along the bottom on a phone —
 * the same list, moved to the edge a thumb reaches. It was a header until the
 * panels outgrew it: five fit across the top and the sixth would not, and every
 * page underneath was paying a band of height for a list nobody reads twice.
 *
 * The uplink goes with it. On the rail it sits at the foot; where the foot is
 * taken by navigation it moves to the top and stays there while the page
 * scrolls. Losing it when leaving this panel was the strongest argument for
 * moving the navigation at all, so it would be a poor trade to lose it anyway.
 *
 * English only, and not by omission. Its reader is whoever runs this deployment,
 * the same person the startup log is written for, and most of what it says is
 * technical nouns that a half-translated page renders worse than an
 * untranslated one.
 */
export function Shell({
	who,
	panel,
	onPanel,
	onSignOut,
	load,
	children,
}: {
	who: Who;
	panel: Panel;
	onPanel: (panel: Panel) => void;
	onSignOut: () => void;
	/** What is going out right now, so it is legible from every panel. */
	load?: { out: number; rooms: number; clients: number };
	children: ReactNode;
}) {
	return (
		// The page is the height of the window and the panel scrolls inside it,
		// rather than the whole document scrolling. A rail is a flex item, and a
		// flex item stretches: left to itself it grew to the height of whatever
		// Runtime happened to be showing, which put its own foot — the uplink,
		// the signature, the way out — somewhere below the fold of a page nobody
		// was scrolling to read.
		<div className="flex h-dvh flex-col overflow-hidden bg-bg text-fg lg:flex-row">
			{/* Pinned across the top on a phone, where the foot is taken. */}
			<Crown load={load} onSignOut={onSignOut} />

			<nav
				className={cn(
					"hidden shrink-0 flex-col gap-1 border-border border-r p-3 lg:flex lg:w-48",
					// Its own height, and its own scroll if the list ever outgrows
					// it. Whatever the panel beside it is doing, the rail is the
					// same rail.
					"lg:h-dvh lg:overflow-y-auto",
				)}
			>
				<span className="px-2 pt-1 pb-3 font-semibold text-sm">Management</span>

				{PANELS.map((one) => (
					<Rail key={one} panel={one} current={panel} onPanel={onPanel} />
				))}

				<div className="mt-auto flex flex-col gap-3 pt-3">
					<Load load={load} />
					<div className="flex items-center gap-2">
						<span className="readout truncate text-fg-muted text-[11px]">
							{who.name ? `${who.name} · ` : ""}
							{who.trip}
						</span>
						<Button variant="ghost" size="sm" onClick={onSignOut} className="ml-auto shrink-0">
							Sign out
						</Button>
					</div>
				</div>
			</nav>

			{/* The one thing that scrolls. */}
			<main className="min-w-0 flex-1 overflow-y-auto p-3 pb-20 sm:p-5 lg:pb-5">{children}</main>

			{/* The rail, moved to the one edge a thumb reaches without the hand
			    changing grip. Five is what a row of tabs holds before the labels
			    start abbreviating. */}
			<nav
				className={cn(
					"fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-border border-t bg-surface lg:hidden",
					"pb-[env(safe-area-inset-bottom)]",
				)}
			>
				{PANELS.map((one) => (
					<Tab key={one} panel={one} current={panel} onPanel={onPanel} />
				))}
			</nav>
		</div>
	);
}

function Rail({
	panel,
	current,
	onPanel,
}: {
	panel: Panel;
	current: Panel;
	onPanel: (panel: Panel) => void;
}) {
	const Icon = ICONS[panel];

	return (
		<button
			type="button"
			onClick={() => onPanel(panel)}
			aria-current={panel === current ? "page" : undefined}
			className={cn(
				"flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors",
				panel === current ? "bg-surface-hi text-fg" : "text-fg-muted hover:bg-surface hover:text-fg",
			)}
		>
			<Icon className="size-4 shrink-0" />
			{panel}
		</button>
	);
}

function Tab({
	panel,
	current,
	onPanel,
}: {
	panel: Panel;
	current: Panel;
	onPanel: (panel: Panel) => void;
}) {
	const Icon = ICONS[panel];

	return (
		<button
			type="button"
			onClick={() => onPanel(panel)}
			aria-current={panel === current ? "page" : undefined}
			className={cn(
				"flex flex-col items-center gap-1 py-2 text-[10px] transition-colors",
				panel === current ? "text-tally" : "text-fg-muted",
			)}
		>
			<Icon className="size-4" />
			{panel}
		</button>
	);
}

/** The reading that must survive leaving the panel it belongs to. */
function Crown({
	load,
	onSignOut,
}: {
	load?: { out: number; rooms: number; clients: number };
	onSignOut: () => void;
}) {
	return (
		<header
			className={cn(
				"z-20 flex shrink-0 items-baseline gap-2 border-border border-b bg-surface px-3 py-2 lg:hidden",
				"pt-[max(0.5rem,env(safe-area-inset-top))]",
			)}
		>
			<span className="readout font-semibold text-[15px] text-tally tabular-nums">
				{load ? rate(load.out) : "—"}
			</span>
			<span className="text-fg-muted text-[11px]">
				{load ? `${load.rooms} rooms · ${load.clients} people` : "management"}
			</span>

			<Button variant="ghost" size="sm" onClick={onSignOut} className="ml-auto shrink-0">
				Sign out
			</Button>
		</header>
	);
}

/** The same reading at the foot of the rail, where there is room to say more. */
function Load({ load }: { load?: { out: number; rooms: number; clients: number } }) {
	return (
		<div className="flex flex-col gap-0.5 border-border border-t pt-3">
			<span className="readout font-semibold text-[15px] text-tally tabular-nums">
				{load ? rate(load.out) : "—"}
			</span>
			<span className="text-fg-muted text-[11px]">uplink</span>
			{load && (
				<span className="text-fg-muted text-[11px]">
					{load.rooms} rooms · {load.clients} people
				</span>
			)}
		</div>
	);
}

/** A titled block, which every panel is made of. */
export function Card({
	title,
	note,
	children,
	className,
	actions,
}: {
	title: string;
	note?: string;
	children: ReactNode;
	className?: string;
	actions?: ReactNode;
}) {
	return (
		<section className={cn("rounded-lg border border-border bg-surface", className)}>
			<header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-border border-b px-3 py-2.5 sm:px-4">
				<h2 className="font-medium text-[13px]">{title}</h2>
				{note && <p className="text-fg-muted text-xs">{note}</p>}
				{actions && <div className="ml-auto">{actions}</div>}
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
