import { useT } from "@/hooks/useT";
import type { Phrase } from "@/live/i18n";
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
	const t = useT();

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
		<Card title={t("New rooms")} note={t("Who can start one")}>
			{error && <Failed>{error}</Failed>}

			<div className="flex flex-col gap-3 px-3 py-3 sm:px-4">
				{/*
				  * Three rows rather than three segments. The labels are not the
				  * same length and the difference between them is not a matter of
				  * degree, so a segmented control gave one option twice the width
				  * of another and still had to explain itself in a sentence
				  * underneath — which meant reading two places to answer one
				  * question. Each row now carries its own consequence.
				  */}
				<div role="radiogroup" aria-label={t("Who can start a new room")} className="flex flex-col">
					<Choice
						label={t("Anyone")}
						describes={t("Anybody with a link can start one.")}
						chosen={value?.chosen === "anyone"}
						disabled={!canModerate || saving || !value}
						onChoose={() => choose("anyone")}
					/>
					<Choice
						label={t("Users & administrators")}
						describes={t(
							"Anybody who has set a passphrase can start one. Everybody else can still join a room they have a link to.",
						)}
						chosen={value?.chosen === "signed"}
						disabled={!canModerate || saving || !value}
						onChoose={() => choose("signed")}
					/>
					<Choice
						label={t("Administrators")}
						describes={t("Only administrators can start one. Rooms already in use stay open.")}
						chosen={value?.chosen === "admins"}
						disabled={!canModerate || saving || !value}
						onChoose={() => choose("admins")}
					/>
				</div>

				{value && <HowLongItLasts remember={value.remember} />}
				{value && <WhereItLives policy={value} />}
				{value && <Caveats policy={value} canModerate={canModerate} />}
			</div>
		</Card>
	);
}

function Choice({
	label,
	describes,
	chosen,
	disabled,
	onChoose,
}: {
	label: string;
	describes: string;
	chosen: boolean;
	disabled: boolean;
	onChoose: () => void;
}) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={chosen}
			disabled={disabled}
			onClick={onChoose}
			className={cn(
				"group relative flex items-start gap-3 rounded-lg py-2.5 pr-3 pl-3 text-left",
				"transition-colors duration-150",
				"focus-visible:outline-2 focus-visible:outline-fg focus-visible:outline-offset-1",
				chosen ? "bg-fg/8" : "hover:bg-fg/5",
				disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
			)}
		>
			{/* A ring that fills rather than a tick that appears, so the three of
			    them read as one question with one answer. */}
			<span
				className={cn(
					"mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-150",
					chosen ? "border-tally" : "border-fg/25 group-hover:border-fg/40",
				)}
			>
				<span
					className={cn(
						"size-2 rounded-full bg-tally transition-transform duration-150",
						chosen ? "scale-100" : "scale-0",
					)}
				/>
			</span>

			<span className="min-w-0">
				<span className={cn("block text-[13px]", chosen ? "font-medium text-fg" : "text-fg")}>
					{label}
				</span>
				<span className="mt-0.5 block text-[11.5px] text-fg-muted leading-relaxed">
					{describes}
				</span>
			</span>
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
	const t = useT();

	return (
		<p className="text-fg-muted text-xs leading-relaxed">
			{remember > 0 ? (
				<>{t("Unused rooms close after")}<Value>{days(remember, t)}</Value>.
				</>
			) : (
				<>{t("Rooms never close.")}</>
			)}
		</p>
	);
}

/**
 * A retention said the way somebody would say it out loud.
 *
 * Takes the translator so the number comes back in the reader's language. It
 * used to build the string itself, so a panel that spoke four languages ended
 * its one sentence about retention with "30 days" in every one of them.
 *
 * Four phrases rather than two with a placeholder for the unit, because the
 * singular and the plural are different words in English and the same word in
 * Japanese, and a sentence assembled from a number and a separately translated
 * noun can only ever come out in the order English wanted.
 */
function days(seconds: number, t: ReturnType<typeof useT>): string {
	const whole = Math.round(seconds / 86_400);
	if (whole >= 1) {
		return whole === 1 ? t("1 day") : t("{count} days", { count: String(whole) });
	}

	const hours = Math.max(1, Math.round(seconds / 3_600));

	return hours === 1 ? t("1 hour") : t("{count} hours", { count: String(hours) });
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
	const t = useT();

	if (policy.configured === policy.chosen) {
		return (
			<p className="text-fg-muted text-xs leading-relaxed">{t("Set here, not in the config file.")}</p>
		);
	}

	return (
		<Note kind="quiet">
			{t("The config file says")}
			<Value>{t(words(policy.configured))}</Value>
			{t(". This setting wins.")}
		</Note>
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
	const t = useT();

	return (
		<>
			{policy.openedBy !== policy.chosen && (
				<Note kind="warn">{t("No administrators are configured, so anyone can start a room.")}</Note>
			)}

			{!canModerate && <Note kind="quiet">{t("You can view this but not change it.")}</Note>}
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

/**
 * The setting as it is written down, said the way the switch says it.
 *
 * Three answers rather than two. This used to fold "signed" into "anyone",
 * which made the panel say the config file was set to something it was not —
 * and "signed" is the middle setting, the one most deployments want, so the
 * reading was wrong exactly where somebody was most likely to be checking it.
 * Two places show this: the note under the switch and the runtime readout.
 *
 * Returned as a phrase rather than a sentence, because both readers put it
 * inside one of their own.
 */
export function words(opening: Opening): Phrase {
	if (opening === "admins") return "administrators";
	if (opening === "signed") return "users and administrators";

	return "anyone";
}
