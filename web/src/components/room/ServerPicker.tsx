import { cn } from "@/lib/utils";
import { useT } from "@/hooks/useT";
import { say } from "@/live/i18n";
import { type Relay, timings } from "@/live/relays";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
	const frame = useRef<HTMLDivElement>(null);

	// Measured when the menu opens rather than on load, because the measurement
	// costs a connection to every relay and most people never open this.
	useEffect(() => {
		if (!open || measured) return;

		let live = true;
		void timings(relays).then((result) => {
			if (live) setMeasured(result);
		});

		return () => {
			live = false;
		};
	}, [open, measured, relays]);

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
					<Option
						label={t("Automatic")}
						describes={t("Whichever answers fastest")}
						chosen={value === ""}
						onPick={() => {
							onChange("");
							setOpen(false);
						}}
					/>

					{relays.map((relay, index) => (
						<Option
							key={relay.name}
							label={say(relay.label || relay.name)}
							describes={relay.fallback ? "[Fallback]" : relay.region}
							chosen={value === relay.name}
							latency={<Latency ms={measured?.get(relay.name)} known={measured !== undefined} />}
							// Staggered so the list comes in as a list rather than as
							// one block. Small enough to read as movement and not as
							// waiting.
							delay={index * 30}
							onPick={() => {
								onChange(relay.name);
								setOpen(false);
							}}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

function Option({
	label,
	describes,
	chosen,
	latency,
	delay = 0,
	onPick,
}: {
	label: string;
	describes?: string;
	chosen: boolean;
	latency?: React.ReactNode;
	delay?: number;
	onPick: () => void;
}) {
	return (
		<li role="option" aria-selected={chosen}>
			<button
				type="button"
				onClick={onPick}
				style={{ animationDelay: `${delay}ms` }}
				className={cn(
					"flex w-full animate-arrive items-center gap-2.5 px-3 py-2.5 text-left",
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
