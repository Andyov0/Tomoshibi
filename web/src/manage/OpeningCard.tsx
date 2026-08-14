import { cn } from "@/lib/utils";
import { actionFailed } from "@/live/notices";
import { type ReactNode, useCallback, useState } from "react";
import { type Opening, type Policy, api } from "./api";
import { usePoll } from "./poll";
import { Card, Failed } from "./Shell";

/**
 * Who may open a room that has never been used.
 *
 * The only setting on this surface that changes what somebody outside it can
 * do, and the only one that outlives the person who sets it. Everything else
 * here ends a call or silences a track; this decides whether a call can begin.
 *
 * It reads as a choice about names rather than about people because that is
 * what it is. There is no room object on this server to be created or owned: a
 * name is opened by being joined for the first time, and this says who may be
 * the first. A name already in use is nobody's to open again, so a meeting in
 * progress is out of this setting's reach entirely — which is the sentence
 * under the switch, because it is the first thing anybody about to press it
 * wants to know.
 */
export function OpeningCard({
	canModerate,
	onSignedOut,
}: {
	canModerate: boolean;
	onSignedOut: () => void;
}) {
	const [saving, setSaving] = useState(false);

	// Rarely, because this changes only when somebody on this page changes it.
	// Polled at all so that two administrators with the panel open do not spend
	// an afternoon each believing their own version.
	const { value, error, refresh } = usePoll(api.policy, { every: 30_000, onSignedOut });

	const choose = useCallback(
		async (openedBy: Opening) => {
			if (saving || value?.chosen === openedBy) return;

			setSaving(true);

			try {
				await api.setPolicy(openedBy);
				await refresh();
			} catch (err) {
				// The switch stays where it was, because nothing moved. Said the
				// way every other press that did not take is said here.
				actionFailed(err instanceof Error ? err.message : String(err));
			} finally {
				setSaving(false);
			}
		},
		[refresh, saving, value?.chosen],
	);

	return (
		<Card title="New rooms" note="Who may use a name nobody has used">
			{error && <Failed>{error}</Failed>}

			<div className="flex flex-col gap-3 px-3 py-3 sm:px-4">
				<div
					role="group"
					aria-label="Who may open a new room"
					className="grid grid-cols-2 gap-1 rounded-md border border-border bg-bg p-1"
				>
					<Choice
						label="Anyone"
						chosen={value?.chosen === "anyone"}
						disabled={!canModerate || saving || !value}
						onChoose={() => choose("anyone")}
					/>
					<Choice
						label="Administrators"
						chosen={value?.chosen === "admins"}
						disabled={!canModerate || saving || !value}
						onChoose={() => choose("admins")}
					/>
				</div>

				<p className="text-fg-muted text-xs leading-relaxed">
					{value?.chosen === "admins"
						? "A name nobody has used is refused unless the passphrase sent with the join is an administrator's. Rooms already in use stay open to everybody who has the name."
						: "Anybody who asks for a name nobody has used opens it, which is what an anonymous meeting link means."}
				</p>

				{value && <HowLongItLasts remember={value.remember} />}
				{value && <WhereItLives policy={value} />}
				{value && <Caveats policy={value} canModerate={canModerate} />}
			</div>
		</Card>
	);
}

function Choice({
	label,
	chosen,
	disabled,
	onChoose,
}: {
	label: string;
	chosen: boolean;
	disabled: boolean;
	onChoose: () => void;
}) {
	return (
		<button
			type="button"
			aria-pressed={chosen}
			disabled={disabled}
			onClick={onChoose}
			className={cn(
				"rounded px-3 py-1.5 text-[13px] transition-colors",
				"focus-visible:outline-2 focus-visible:outline-fg focus-visible:outline-offset-1",
				chosen ? "bg-surface-hi font-medium text-fg" : "text-fg-muted hover:text-fg",
				disabled && "cursor-not-allowed opacity-60 hover:text-fg-muted",
			)}
		>
			{label}
		</button>
	);
}

/**
 * How long a room stays open once it is.
 *
 * The other half of the switch above, and it belongs beside it: one says who may
 * open a room and this says how long one lasts unattended, and either read
 * without the other is half a rule. Where only administrators may open a room,
 * this is when the door closes again.
 *
 * It ages the record out for a second reason, which is that there was nothing
 * ageing it out at all: a name is written down the first time somebody joins it
 * and nothing ever took one away, so the file grew for as long as anybody asked
 * for names.
 */
function HowLongItLasts({ remember }: { remember: number }) {
	return (
		<p className="text-fg-muted text-xs leading-relaxed">
			{remember > 0 ? (
				<>
					A name nobody has joined for <Value>{days(remember)}</Value> is forgotten, and is a
					name nobody has used again.
				</>
			) : (
				<>Every name that has ever been used is kept, and no room is ever forgotten.</>
			)}
		</p>
	);
}

/** A retention said the way somebody would say it out loud. */
function days(seconds: number): string {
	const whole = Math.round(seconds / 86_400);
	if (whole >= 1) return `${whole} ${whole === 1 ? "day" : "days"}`;

	const hours = Math.max(1, Math.round(seconds / 3_600));

	return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/**
 * Where this setting lives, said whether or not anything is wrong.
 *
 * The one rule about it that catches people, and it catches them precisely
 * when nothing looks wrong: the file is read once, on the first run of a fresh
 * store, and never again. Somebody who sets this here and later edits the file
 * to match — or edits the file expecting it to take — gets no error, no
 * warning, and a server doing something the file does not say.
 *
 * It used to be said only when the two disagreed, which is the moment it is
 * already too late to be told. The explanation was also in the other panel,
 * next to the readings rather than next to the switch, and nobody reading a
 * switch goes looking in a second place for what it does.
 */
function WhereItLives({ policy }: { policy: Policy }) {
	const agrees = policy.configured === policy.chosen;

	return (
		<p className="border-border border-l-2 pl-2.5 text-fg-muted text-xs leading-relaxed">
			Held in the store rather than the configuration file, because these pages have no file to
			edit. <Value>meet.rooms.opened_by</Value> says <Value>{words(policy.configured)}</Value>,
			and is read once — when a fresh store first runs.{" "}
			{agrees
				? "Editing it afterwards changes nothing here."
				: "This was changed from here since, and what is set here is what the server does."}
		</p>
	);
}

/**
 * The two ways this setting is not what somebody thinks it is.
 *
 * Both are silent by nature: a switch drawn from what is stored looks identical
 * whether or not the server is obeying it, and whether or not the person
 * looking at it is allowed to move it.
 */
function Caveats({ policy, canModerate }: { policy: Policy; canModerate: boolean }) {
	return (
		<>
			{policy.openedBy !== policy.chosen && (
				<Note kind="warn">
					Nobody is configured as an administrator, so nothing could satisfy this and anybody
					may open a room. List one in the configuration file to put it into effect.
				</Note>
			)}

			{!canModerate && <Note kind="quiet">Shown here to be read. Changing it needs moderation.</Note>}
		</>
	);
}

function Note({ kind, children }: { kind: "warn" | "quiet"; children: ReactNode }) {
	return (
		<p
			className={cn(
				"border-l-2 pl-2.5 text-xs leading-relaxed",
				// The one signal colour this interface has. A second hue for
				// warnings would be a second thing on screen claiming to be the
				// thing worth looking at.
				kind === "warn" ? "border-tally text-tally" : "border-border text-fg-muted",
			)}
		>
			{children}
		</p>
	);
}

function Value({ children }: { children: ReactNode }) {
	return <span className="readout text-fg">{children}</span>;
}

/** The setting as it is written down, said the way the switch says it. */
export function words(opening: Opening): string {
	return opening === "admins" ? "administrators" : "anyone";
}
