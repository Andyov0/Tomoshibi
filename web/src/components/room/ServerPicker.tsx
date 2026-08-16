import { cn } from "@/lib/utils";
import { useT } from "@/hooks/useT";
import { say } from "@/live/i18n";
import { type Relay, timings } from "@/live/relays";
import { Check, ChevronDown, Loader2, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Choosing where the call will be held, with what each one costs.
 *
 * A list of place names is not a choice anybody can make. "Shanghai" and
 * "Hong Kong" tell somebody nothing about which will carry their voice better,
 * and the one piece of information that would — how long a packet takes to get
 * there and back — is something this page can measure in a second and is
 * already measuring in order to choose automatically. Withholding it and then
 * asking the person to decide is asking them to guess at the answer it has.
 *
 * So the numbers are here, and they arrive as they are measured rather than all
 * at once: a relay that is down should not hold up the three that answered
 * immediately, and watching them land one at a time is also the clearest
 * possible statement that they are being measured now rather than remembered.
 *
 * Built rather than a native select, and not for the look. A native option can
 * hold one line of text and no marks: no colour for how good a number is, no
 * second line, nothing that arrives after the menu is open. All three are the
 * whole point here.
 */
/**
 * How long the button is held shut after a measurement.
 *
 * Short enough that somebody who genuinely wants a fresh reading is not made to
 * wait, long enough that the button cannot be held down — which would be a
 * burst of connections to every relay, from every browser, aimed at one's own
 * machines.
 */
const COOLDOWN_MS = 5000;

export function ServerPicker({
	relays,
	value,
	onChange,
}: {
	relays: Relay[];
	value: string;
	onChange: (name: string) => void;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [measured, setMeasured] = useState<Map<string, number | undefined>>();
	const [measuring, setMeasuring] = useState(false);
	const [ready, setReady] = useState(true);
	const frame = useRef<HTMLDivElement>(null);
	const alive = useRef(true);

	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	/**
	 * Take the measurement, at most once every few seconds.
	 *
	 * The limit is on the button rather than on the network layer because of
	 * what a measurement is here: one connection to every relay, from every
	 * browser that presses it. A button somebody can hold down is a small
	 * denial-of-service aimed at one's own machines, and — the reason that
	 * matters more than the load — a burst of connections to an unregistered
	 * host in mainland China is what got a relay's name blacklisted before.
	 *
	 * Five seconds is also about how long it takes to stop believing the number
	 * you just read, which is the only honest reason to press it again.
	 */
	const measure = useCallback(() => {
		if (!ready) return;

		setReady(false);
		setMeasuring(true);

		void timings(relays).then((result) => {
			if (!alive.current) return;

			setMeasured(result);
			setMeasuring(false);
		});

		setTimeout(() => {
			if (alive.current) setReady(true);
		}, COOLDOWN_MS);
	}, [ready, relays]);

	// Measured when the menu is first opened rather than on load, because it
	// costs a connection to every relay and most people never open this. Not on
	// every open: the numbers do not move that fast, and the button below is
	// there for anybody who thinks they have.
	useEffect(() => {
		if (!open || measured || measuring) return;

		measure();
	}, [open, measured, measuring, measure]);

	// Closed by anything that is not this. A menu that stays open behind the
	// rest of the page is one somebody has to find their way out of.
	useEffect(() => {
		if (!open) return;

		const away = (event: MouseEvent) => {
			if (!frame.current?.contains(event.target as Node)) setOpen(false);
		};

		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};

		document.addEventListener("mousedown", away);
		document.addEventListener("keydown", escape);

		return () => {
			document.removeEventListener("mousedown", away);
			document.removeEventListener("keydown", escape);
		};
	}, [open]);

	const chosen = relays.find((relay) => relay.name === value);

	return (
		<div ref={frame} className="relative flex flex-col gap-1.5">
			<span className="text-fg-muted text-xs">{t("Server")}</span>

			<button
				type="button"
				aria-haspopup="listbox"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className={cn(
					"flex h-11 items-center gap-2 rounded-lg border border-border bg-surface-2 px-3",
					"text-left text-fg text-sm outline-none transition-colors",
					"hover:bg-surface-hi focus-visible:ring-2 focus-visible:ring-fg/40",
				)}
			>
				<span className="min-w-0 flex-1 truncate">
					{chosen ? say(chosen.label || chosen.name) : t("Automatic")}
				</span>

				{chosen && <Latency ms={measured?.get(chosen.name)} known={measured !== undefined} />}

				<ChevronDown
					className={cn(
						"size-4 shrink-0 text-fg-muted transition-transform duration-200",
						open && "rotate-180",
					)}
				/>
			</button>

			{open && (
				<ul
					role="listbox"
					className={cn(
						"absolute top-full right-0 left-0 z-20 mt-1.5 overflow-hidden rounded-lg",
						"border border-border bg-surface-hi shadow-lg",
						// Arrives from just under the control rather than appearing:
						// a menu that fades in from nowhere reads as a page redraw.
						"origin-top animate-arrive",
					)}
				>
					<li className="flex items-center justify-between gap-2 border-border border-b px-3 py-1.5">
						<span className="text-fg-muted text-[10.5px] uppercase tracking-wide">
							{t("Round trip")}
						</span>

						<button
							type="button"
							disabled={!ready || measuring}
							onClick={measure}
							className={cn(
								"flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-muted",
								"transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40",
								"disabled:hover:bg-transparent disabled:hover:text-fg-muted",
							)}
						>
							<RotateCw className={cn("size-3", measuring && "animate-spin")} />
							{t("Measure again")}
						</button>
					</li>

					<Option
						label={t("Automatic")}
						describes={t("Whichever answers fastest")}
						chosen={value === ""}
						onPick={() => {
							onChange("");
							setOpen(false);
						}}
					/>

					{grouped(relays).map((row, index) =>
						row.kind === "heading" ? (
							<Heading key={`h${row.path}`} text={row.text} depth={row.depth} delay={index * 30} />
						) : (
							<Option
								key={row.relay.name}
								label={say(row.relay.label || row.relay.name)}
								describes={row.relay.fallback ? "[Fallback]" : undefined}
								chosen={value === row.relay.name}
								depth={row.depth}
								latency={
									<Latency
										ms={measured?.get(row.relay.name)}
										known={measured !== undefined}
									/>
								}
								// Staggered so the list comes in as a list rather than as
								// one block. Small enough to read as movement and not as
								// waiting.
								delay={index * 30}
								onPick={() => {
									onChange(row.relay.name);
									setOpen(false);
								}}
							/>
						),
					)}
				</ul>
			)}
		</div>
	);
}

/**
 * A row of the menu: either a relay or a heading above a run of them.
 *
 * Flattened into a list rather than nested into a tree, because the menu is a
 * list — a listbox with nested lists inside it is a thing screen readers have to
 * be told how to read, and the nesting here is entirely a matter of two levels
 * of indentation.
 */
type Row =
	| { kind: "heading"; text: string; depth: number; path: string }
	| { kind: "relay"; relay: Relay; depth: number };

/**
 * Group the relays by their region, which is a path.
 *
 * "China Mainland" puts a relay directly under one heading; "Oversea/Asia" puts
 * it under two. A path rather than a second field, because the field already
 * existed, is already editable, and a deployment that wants no grouping simply
 * leaves it as it was — those relays come out at the top, ungrouped, which is
 * exactly the list this replaced.
 *
 * Headings appear in the order their first relay does, so an operator who has
 * ordered the relays has ordered the groups too. Sorting them would have quietly
 * overruled that.
 */
export function grouped(relays: Relay[]): Row[] {
	const rows: Row[] = [];
	let open: string[] = [];

	for (const relay of relays) {
		const path = (relay.region ?? "")
			.split("/")
			.map((part) => part.trim())
			.filter(Boolean);

		// Only the headings that are not already open. A run of relays in one
		// group prints its heading once.
		let shared = 0;
		while (shared < path.length && shared < open.length && path[shared] === open[shared]) {
			shared += 1;
		}

		for (let depth = shared; depth < path.length; depth += 1) {
			const text = path[depth];
			if (text === undefined) continue;

			rows.push({
				kind: "heading",
				text,
				depth,
				path: path.slice(0, depth + 1).join("/"),
			});
		}

		open = path;
		rows.push({ kind: "relay", relay, depth: path.length });
	}

	return rows;
}

function Heading({ text, depth, delay }: { text: string; depth: number; delay: number }) {
	return (
		<li
			aria-hidden="true"
			style={{ animationDelay: `${delay}ms`, paddingLeft: `${0.75 + depth * 0.75}rem` }}
			className={cn(
				"animate-arrive pt-2 pb-1 pr-3 font-medium text-fg-muted text-[10.5px] uppercase tracking-wide",
				depth > 0 && "text-fg-muted/70 normal-case tracking-normal",
			)}
		>
			{say(text)}
		</li>
	);
}

function Option({
	label,
	describes,
	chosen,
	latency,
	depth = 0,
	delay = 0,
	onPick,
}: {
	label: string;
	describes?: string;
	chosen: boolean;
	latency?: React.ReactNode;
	depth?: number;
	delay?: number;
	onPick: () => void;
}) {
	return (
		<li role="option" aria-selected={chosen}>
			<button
				type="button"
				onClick={onPick}
				style={{ animationDelay: `${delay}ms`, paddingLeft: `${0.75 + depth * 0.75}rem` }}
				className={cn(
					"flex w-full animate-arrive items-center gap-2.5 py-2.5 pr-3 text-left",
					"transition-colors hover:bg-surface-2",
					chosen && "bg-surface-2",
				)}
			>
				<Check
					className={cn("size-3.5 shrink-0 text-tally transition-opacity", !chosen && "opacity-0")}
				/>

				<span className="min-w-0 flex-1">
					<span className="block truncate text-fg text-sm">{label}</span>
					{describes && <span className="block truncate text-fg-muted text-[11px]">{describes}</span>}
				</span>

				{latency}
			</button>
		</li>
	);
}

/**
 * How far away a relay is, in the two things somebody reads at once.
 *
 * The number for anybody comparing two of them, and the colour for anybody who
 * only wants to know whether this one is fine. Same bands as the connection
 * light in a call, so that a relay chosen here for showing green does not turn
 * amber the moment the call starts.
 */
function Latency({ ms, known }: { ms: number | undefined; known: boolean }) {
	const t = useT();

	if (!known) {
		return <Loader2 className="size-3.5 shrink-0 animate-spin text-fg-muted/60" />;
	}

	if (ms === undefined) {
		return <span className="shrink-0 text-[11px] text-danger">{t("no answer")}</span>;
	}

	const colour = ms <= 150 ? "text-good" : ms <= 400 ? "text-tally" : "text-danger";

	return (
		<span
			className={cn(
				"readout shrink-0 animate-arrive tabular-nums text-[11.5px]",
				colour,
			)}
		>
			{Math.round(ms)} ms
		</span>
	);
}
