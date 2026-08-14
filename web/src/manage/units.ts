/**
 * Turning the server's numbers into something a person reads.
 *
 * The units matter more here than anywhere else in this application. A rate and
 * a total look alike on a screen, and one of them answers "how close are we to
 * the ceiling" while the other answers nothing at all unless you also know when
 * the process started.
 */

/** Bits per second, from the bytes per second the server counts in. */
export function rate(bytesPerSecond: number): string {
	const bits = bytesPerSecond * 8;

	if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gbps`;
	if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mbps`;
	if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} kbps`;

	return `${Math.round(bits)} bps`;
}

/** A total, which is bytes and stays bytes. */
export function size(bytes: number): string {
	if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
	if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
	if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} kB`;

	return `${bytes} B`;
}

/** A bitrate a codec was configured with, which is bits already. */
export function bitrate(bits: number): string {
	if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mbps`;
	if (bits >= 1e3) return `${Math.round(bits / 1e3)} kbps`;

	return `${bits} bps`;
}

/** How long, in the largest unit that still says something. */
export function since(iso: string): string {
	const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);

	if (seconds < 60) return `${Math.floor(seconds)}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86_400) {
		const hours = Math.floor(seconds / 3600);
		return `${hours}h ${Math.floor((seconds - hours * 3600) / 60)}m`;
	}

	const days = Math.floor(seconds / 86_400);
	return `${days}d ${Math.floor((seconds - days * 86_400) / 3600)}h`;
}

/** A wall-clock time, to the second, for a log. */
export function clock(iso: string): string {
	return new Date(iso).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

/** A date, for something that happened on another day. */
export function day(iso: string): string {
	return new Date(iso).toLocaleDateString("en-GB", {
		year: "numeric",
		month: "short",
		day: "2-digit",
	});
}

/**
 * What this deployment's link is thought to carry.
 *
 * Used only to draw how full the pipe is. The figure is not measured and cannot
 * be: the server knows what it is sending, not what the wire beneath it can
 * hold. A gigabit is what the interface on this deployment negotiates, and the
 * bar is honest only as far as that is.
 */
export const LINK_BITS = 1e9;
