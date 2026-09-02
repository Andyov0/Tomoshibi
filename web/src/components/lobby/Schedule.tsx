import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import { Refused } from "@/live/api";
import { locale } from "@/live/i18n";
import { type Arrangement, arrange, arrangements, cancel, linkFor, whenSaid } from "@/live/meeting";
import { type Relay } from "@/live/relays";
import { ServerList } from "@/components/room/ServerPicker";
import { generateRoomName, normaliseRoomName, validRoomName } from "@/live/names";
import { actionFailed } from "@/live/notices";
import { cn } from "@/lib/utils";
import { CalendarClock, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

/**
 * Arranging a meeting, from the lobby.
 *
 * A card that opens. Closed it is one line, like the two forms above it; open
 * it is the whole question — which name, which day, what time, which machine —
 * laid out with room to answer each. The first version put all of it on one
 * row beside a native date field, and on a screen wide enough for the lobby
 * the name field was squeezed to the width of a cursor while the date field
 * read "dd/mm/yyyy, --:-- --". It looked like a form somebody had given up on.
 *
 * ## Why the picker is drawn here
 *
 * The rule in this codebase is to prefer the platform's control over one of
 * its own, and the date field is the exception that proves it. The platform's
 * control for a date and a time is the one thing in the browser that looks
 * different on every browser and good on none of them, cannot be styled, and
 * asks for a year and a month for a meeting that is next Tuesday. What is
 * needed is smaller than what it offers: a day in the next sixty, and a time
 * to the quarter hour. That is a grid and two lists, and both are drawn with
 * the same pieces the rest of the lobby is drawn with.
 *
 * The hour and the minute stay platform selects. A list of twenty-four is a
 * list, and the platform draws lists well.
 */
export function Schedule({
	servers,
	server,
	onServer,
	onOpenChange,
}: {
	servers: Relay[];
	server: string;
	onServer: (relay: string) => void;
	/** Said so the lobby can put its own server list away while this is open:
	 * the list is the same list, and two of it on one screen is a mistake. */
	onOpenChange: (open: boolean) => void;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);

	useEffect(() => onOpenChange(open), [open, onOpenChange]);
	const { mounted, leaving } = useLingering(open);

	const [planning, setPlanning] = useState("");
	const [day, setDay] = useState<Date>();
	const [hour, setHour] = useState(() => nextQuarter().getHours());
	const [minute, setMinute] = useState(() => nextQuarter().getMinutes());
	const [arranging, setArranging] = useState(false);
	const [mine, setMine] = useState<Arrangement[]>([]);
	const [copied, setCopied] = useState<string>();

	useEffect(() => {
		void arrangements()
			.then(setMine)
			.catch(() => {
				// A list that could not be read is an empty list, not an error
				// worth a notice: arranging still works.
			});
	}, []);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(undefined), 1600);
		return () => clearTimeout(timer);
	}, [copied]);

	// The instant being arranged, or nothing until a day is chosen.
	const at = useMemo(() => {
		if (!day) return undefined;
		const d = new Date(day);
		d.setHours(hour, minute, 0, 0);
		return d;
	}, [day, hour, minute]);

	// Not in the past. The server allows an hour's grace for a form filled in
	// slowly; the button does not offer a time that has already gone.
	const past = at !== undefined && at.getTime() < Date.now();

	const plan = async () => {
		if (arranging || !at || past) return;

		const room = validRoomName(normaliseRoomName(planning)) ? normaliseRoomName(planning) : generateRoomName();

		setArranging(true);

		try {
			const made = await arrange(room, at, server);
			setMine((was) => [...was, made].sort((a, b) => a.at.localeCompare(b.at)));
			setPlanning("");
			setDay(undefined);

			// Straight onto the clipboard, because the link is the whole point
			// and the next thing anybody does with it is paste it somewhere.
			await navigator.clipboard.writeText(linkFor(made)).then(
				() => setCopied(made.id),
				() => undefined,
			);
		} catch (whatever) {
			actionFailed(explainArranging(whatever, t));
		} finally {
			setArranging(false);
		}
	};

	const copyLink = (one: Arrangement) => {
		void navigator.clipboard.writeText(linkFor(one)).then(
			() => setCopied(one.id),
			() => undefined,
		);
	};

	const drop = async (one: Arrangement) => {
		try {
			await cancel(one.id);
			setMine((was) => was.filter((m) => m.id !== one.id));
		} catch (whatever) {
			actionFailed(explainArranging(whatever, t));
		}
	};

	return (
		<section
			className={cn(
				"animate-rise [animation-delay:180ms]",
				"flex flex-col rounded-xl border border-border bg-surface",
			)}
		>
			<button
				type="button"
				onClick={() => setOpen((was) => !was)}
				aria-expanded={open}
				className="flex w-full items-center gap-3.5 p-4 text-left"
			>
				<span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-hi text-fg-muted">
					<CalendarClock className="size-5" />
				</span>
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="font-medium text-[14px]">{t("Schedule a meeting")}</span>
					<span className="text-[12px] text-fg-muted leading-snug">
						{t("Pick a time and hand out the link before it starts.")}
					</span>
				</span>
				<ChevronDown
					className={cn("size-4 shrink-0 text-fg-muted transition-transform duration-200", open && "rotate-180")}
				/>
			</button>

			{mounted && (
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void plan();
					}}
					className={cn("flex flex-col gap-4 px-4 pb-4", leaving ? "animate-depart" : "animate-arrive")}
				>
					<label className="flex flex-col gap-1.5">
						<span className="text-[11px] text-fg-muted">{t("Room name")}</span>
						<Input
							value={planning}
							onChange={(event) => setPlanning(event.target.value)}
							placeholder={t("Room name")}
							aria-label={t("Name for the new room")}
							maxLength={64}
							className="bg-surface-hi"
						/>
						<span className="text-[11.5px] text-fg-muted leading-snug">
							{t("Name it yourself, or leave it blank for one nobody has used.")}
						</span>
					</label>

					<div className="flex flex-col gap-1.5">
						<span className="text-[11px] text-fg-muted">{t("Day")}</span>
						<DayGrid value={day} onChange={setDay} />
					</div>

					<div className="flex flex-col gap-1.5">
						<span className="text-[11px] text-fg-muted">{t("Time")}</span>
						<div className="flex items-center gap-2">
							<Clock value={hour} onChange={setHour} count={24} label={t("Hour")} />
							<span className="text-fg-muted">:</span>
							<Clock value={minute} onChange={setMinute} count={60} step={15} label={t("Minute")} />
						</div>
					</div>

					{/* The same list the lobby shows for starting and joining, brought
					    in here so the machine is chosen where the meeting is arranged
					    rather than somewhere below it. */}
					{servers.length > 1 && <ServerList relays={servers} value={server} onChange={onServer} />}

					<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
						<span className="min-w-0 text-[12.5px] text-fg-muted leading-snug">
							{at
								? past
									? t("That time has already gone.")
									: t("Arranged for {when}", { when: whenSaid(at.toISOString()) })
								: t("Choose a day.")}
						</span>
						<Button type="submit" variant="primary" disabled={!at || past || arranging} className="shrink-0">
							{arranging ? <Loader2 className="size-4 animate-spin" /> : t("Arrange")}
						</Button>
					</div>

					{mine.length > 0 && (
						<ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
							{mine.map((one) => (
								<li key={one.id} className="flex items-center gap-2 px-3 py-2">
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="readout truncate text-[13px]">{one.room}</span>
										<span className="truncate text-[11.5px] text-fg-muted">
											{whenSaid(one.at)}
											{one.ended ? ` · ${t("Over")}` : one.started ? ` · ${t("Under way")}` : ""}
										</span>
									</span>

									<Button
										type="button"
										variant="ghost"
										size="icon"
										className="size-8"
										aria-label={copied === one.id ? t("Link copied") : t("Copy link")}
										onClick={() => copyLink(one)}
									>
										{copied === one.id ? <Check className="size-4 text-tally" /> : <Copy className="size-4" />}
									</Button>

									<Button
										type="button"
										variant="ghost"
										size="icon"
										className="size-8 text-fg-muted"
										aria-label={t("Cancel meeting")}
										onClick={() => void drop(one)}
									>
										<X className="size-4" />
									</Button>
								</li>
							))}
						</ul>
					)}
				</form>
			)}
		</section>
	);
}

/** How far ahead a day may be chosen. The server's bound, so the grid never
 * offers what the server would refuse. */
const DAYS_AHEAD = 60;

/**
 * A month of days to choose from, limited to the next sixty.
 *
 * Weeks start on Monday, which is how every calendar this deployment's people
 * grew up with is printed. Days outside the window are drawn and disabled
 * rather than hidden, so the grid keeps its shape from one month to the next.
 */
function DayGrid({ value, onChange }: { value?: Date; onChange: (day: Date) => void }) {
	const t = useT();
	const today = startOfDay(new Date());
	const last = new Date(today);
	last.setDate(last.getDate() + DAYS_AHEAD);

	const [shown, setShown] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));

	const monthSaid = new Intl.DateTimeFormat(locale(), { month: "long", year: "numeric" }).format(shown);
	const weekdays = useMemo(() => {
		const f = new Intl.DateTimeFormat(locale(), { weekday: "narrow" });
		// A known Monday.
		return Array.from({ length: 7 }, (_, n) => f.format(new Date(2024, 0, 1 + n)));
	}, []);

	// The cells: leading blanks so the first falls on its weekday, then the
	// month's days.
	const first = new Date(shown.getFullYear(), shown.getMonth(), 1);
	const lead = (first.getDay() + 6) % 7;
	const count = new Date(shown.getFullYear(), shown.getMonth() + 1, 0).getDate();

	const earlier = new Date(shown.getFullYear(), shown.getMonth() - 1, 1);
	const later = new Date(shown.getFullYear(), shown.getMonth() + 1, 1);
	const canGoBack = earlier >= new Date(today.getFullYear(), today.getMonth(), 1);
	const canGoOn = later <= last;

	return (
		<div className="flex w-full max-w-sm flex-col gap-2 rounded-lg border border-border bg-surface-hi p-2">
			<div className="flex items-center justify-between">
				<button
					type="button"
					onClick={() => setShown(earlier)}
					disabled={!canGoBack}
					aria-label={t("Previous month")}
					className="grid size-7 place-items-center rounded-md text-fg-muted hover:bg-surface disabled:opacity-30"
				>
					<ChevronLeft className="size-4" />
				</button>
				<span className="truncate text-[12.5px] font-medium">{monthSaid}</span>
				<button
					type="button"
					onClick={() => setShown(later)}
					disabled={!canGoOn}
					aria-label={t("Next month")}
					className="grid size-7 place-items-center rounded-md text-fg-muted hover:bg-surface disabled:opacity-30"
				>
					<ChevronRight className="size-4" />
				</button>
			</div>

			<div className="grid grid-cols-7 gap-0.5 text-center">
				{weekdays.map((w, n) => (
					<span key={String(n)} className="py-1 text-[10.5px] text-fg-muted">
						{w}
					</span>
				))}

				{Array.from({ length: lead }, (_, n) => (
					<span key={`lead-${String(n)}`} />
				))}

				{Array.from({ length: count }, (_, n) => {
					const d = new Date(shown.getFullYear(), shown.getMonth(), n + 1);
					const offered = d >= today && d <= last;
					const chosen = value !== undefined && sameDay(d, value);
					const isToday = sameDay(d, today);

					return (
						<button
							key={String(n)}
							type="button"
							disabled={!offered}
							onClick={() => onChange(d)}
							aria-pressed={chosen}
							aria-label={new Intl.DateTimeFormat(locale(), { dateStyle: "full" }).format(d)}
							className={cn(
								"h-9 rounded-md text-[12.5px] transition-colors",
								offered ? "hover:bg-surface" : "opacity-30",
								chosen && "bg-fg text-bg hover:bg-fg",
								isToday && !chosen && "ring-1 ring-fg/40",
							)}
						>
							{n + 1}
						</button>
					);
				})}
			</div>
		</div>
	);
}

/** One of the two halves of a time. A platform select, which draws a list of
 * twenty-four well and needs no styling to be read. */
function Clock({
	value,
	onChange,
	count,
	step = 1,
	label,
}: {
	value: number;
	onChange: (n: number) => void;
	count: number;
	step?: number;
	label: string;
}) {
	return (
		<select
			value={value}
			onChange={(event) => onChange(Number(event.target.value))}
			aria-label={label}
			className={cn(
				"h-10 w-24 rounded-lg border border-border bg-surface-hi px-2 text-sm text-fg",
				"outline-none transition-colors focus-visible:border-fg/40 focus-visible:ring-2 focus-visible:ring-fg/25",
			)}
		>
			{Array.from({ length: Math.ceil(count / step) }, (_, n) => n * step).map((n) => (
				<option key={n} value={n}>
					{String(n).padStart(2, "0")}
				</option>
			))}
		</select>
	);
}

function nextQuarter(): Date {
	const d = new Date();
	d.setSeconds(0, 0);
	d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15);
	return d;
}

function startOfDay(d: Date): Date {
	const s = new Date(d);
	s.setHours(0, 0, 0, 0);
	return s;
}

function sameDay(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Sentences for what the server may answer. The codes stay on the wire. */
function explainArranging(whatever: unknown, t: ReturnType<typeof useT>): string {
	const reason = whatever instanceof Refused ? whatever.reason : "";

	switch (reason) {
		case "room_already_arranged":
			return t("That room already has a meeting arranged.");
		case "bad_time":
			return t("That time is not one a meeting can be arranged for.");
		case "meetings_need_invites":
			return t("Meetings here ask for an account, so a link cannot let anybody in.");
		case "not_yours":
			return t("That is somebody else's room.");
		case "too_many_meetings":
			return t("You have as many meetings arranged as you can have.");
		case "invalid_room":
			return t("Room names can only use lowercase letters, numbers and dashes.");
		case "relay_not_allowed":
			return t("Access denied. That server is for administrators.");
		case "not_signed_in":
			return t("Your session has expired. Sign in again.");
		default:
			return t("Something went wrong. Try again.");
	}
}
