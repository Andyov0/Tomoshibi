import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { KeyRound } from "lucide-react";

/**
 * Who somebody is, as one control.
 *
 * A name and the passphrase that proves it were two fields, one above the other,
 * which said they were two decisions. They are not: the passphrase is the whole
 * of what makes the name anybody's, and it is worth nothing on its own. So they
 * are one bordered field with a hairline through it, and the ring on focus
 * belongs to the pair rather than to whichever half is being typed in.
 *
 * The name takes the wider share because it is read as letters and the
 * passphrase is read as dots.
 *
 * Two bare inputs rather than the shared field component, which brings a border
 * and a ring of its own: here the container owns both, and a field inside a
 * field is a box drawn twice.
 */
export function Identity({
	name,
	passphrase,
	onName,
	onPassphrase,
}: {
	name: string;
	passphrase: string;
	onName: (name: string) => void;
	onPassphrase: (passphrase: string) => void;
}) {
	const t = useT();

	return (
		<div
			className={cn(
				"grid grid-cols-[1.25fr_1fr] overflow-hidden rounded-lg border border-border bg-surface",
				"transition-[border-color,box-shadow]",
				"focus-within:border-fg/40 focus-within:ring-2 focus-within:ring-fg/30",
			)}
		>
			<input
				value={name}
				onChange={(event) => onName(event.target.value)}
				placeholder={t("Your name")}
				aria-label={t("Your name")}
				// Named for the password manager rather than for this form. It is
				// what a stored credential is filed under, and what makes the half
				// beside it fill itself at the same time.
				autoComplete="username"
				// biome-ignore lint/a11y/noAutofocus: the screen exists to be typed into
				autoFocus
				maxLength={80}
				className={cn(
					"h-11 min-w-0 bg-transparent px-3 text-fg text-sm outline-none",
					"placeholder:text-fg-muted",
				)}
			/>

			<label className="relative flex min-w-0 items-center border-border border-l">
				{/*
				 * The one place on this screen the signal colour appears, and it
				 * means what it means everywhere else in this application: this is
				 * live. A name nobody can take is the only thing here worth
				 * lighting, and it lights the moment there is something to light.
				 */}
				<KeyRound
					className={cn(
						"pointer-events-none absolute left-3 size-3.5 transition-colors",
						passphrase ? "text-tally" : "text-fg-muted",
					)}
				/>

				<input
					type="password"
					value={passphrase}
					onChange={(event) => onPassphrase(event.target.value)}
					placeholder={t("Passphrase")}
					aria-label={t("Passphrase")}
					autoComplete="current-password"
					maxLength={200}
					className={cn(
						"h-11 min-w-0 w-full bg-transparent pr-3 pl-8.5 text-fg text-sm outline-none",
						"placeholder:text-fg-muted",
					)}
				/>
			</label>
		</div>
	);
}
