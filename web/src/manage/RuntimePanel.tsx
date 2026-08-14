import { api } from "./api";
import { usePoll } from "./poll";
import { Card, Failed } from "./Shell";

/**
 * What the process is actually running with.
 *
 * What it resolved to, not what the file says. More than one afternoon has gone
 * into working out whether a setting took effect — reading the source of the
 * thing that consumes it to find out that one field is quietly overwritten by
 * another. The process knows. It may as well answer.
 *
 * The API key is here and the secret is not. The key names which credential is
 * in use, which is the question anybody has; the secret signs tokens for every
 * room on this deployment, and no page is a reason to put that on a screen.
 */
export function RuntimePanel({ onSignedOut }: { onSignedOut: () => void }) {
	// Once a minute. This changes when somebody restarts the server, and not
	// otherwise.
	const { value, error } = usePoll(api.runtime, { every: 60_000, onSignedOut });

	return (
		<div className="mx-auto grid max-w-4xl gap-4">
			{error && <Failed>{error}</Failed>}

			<Card title="Application">
				<Rows values={value?.meet} />
			</Card>

			<Card title="Media" note="Where clients are told to send, and on what">
				<Rows values={value?.rtc} />
			</Card>

			<Card title="Codecs the media server will carry">
				<p className="readout px-4 py-3 text-[12px] text-fg-muted">
					{value?.codecs.join("  ·  ") ?? "—"}
				</p>
			</Card>

			<Card title="Credentials" note="The secret is not shown here, and will not be">
				<Rows values={value?.credentials} />
			</Card>
		</div>
	);
}

function Rows({ values }: { values?: Record<string, unknown> }) {
	if (!values) return <p className="px-4 py-3 text-fg-muted text-xs">—</p>;

	return (
		// Name above value while narrow, beside it once there is room. A label
		// column of nine rems leaves under two hundred points for a value on a
		// phone, and the values here are addresses and lists.
		<dl className="grid gap-x-4 sm:grid-cols-[minmax(9rem,auto)_1fr]">
			{Object.entries(values).map(([name, value]) => (
				<div key={name} className="contents">
					<dt className="px-3 pt-2 text-fg-muted text-xs sm:border-border sm:border-b sm:px-4 sm:py-2">
						{name}
					</dt>
					<dd className="readout border-border border-b px-3 pt-0.5 pb-2 text-[12px] tabular-nums sm:px-4 sm:py-2">
						{show(value)}
					</dd>
				</div>
			))}
		</dl>
	);
}

function show(value: unknown): string {
	if (value === "" || value === null || value === undefined) return "—";
	if (Array.isArray(value)) return value.length === 0 ? "—" : value.join(", ");
	if (typeof value === "boolean") return value ? "true" : "false";

	return String(value);
}
