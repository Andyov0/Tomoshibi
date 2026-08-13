/**
 * Whether this page may touch cameras and microphones at all.
 *
 * Browsers gate device access on the page being a secure context, and only
 * `localhost` and the loopback addresses are exempt from needing TLS. Over plain
 * HTTP from anywhere else `navigator.mediaDevices` is not merely restricted, it
 * is absent, so the first thing that touches it fails with a type error naming a
 * property rather than the reason it is missing.
 *
 * Checked once, up front, so that the reason can be shown instead.
 */
export function devicesAvailable(): boolean {
	return window.isSecureContext && navigator.mediaDevices !== undefined;
}

/** What to tell somebody who arrived over plain HTTP from another machine. */
export function insecureReason(): string {
	const { protocol, hostname } = window.location;

	if (protocol === "https:") {
		// Secure but still no devices: an old browser, or one where the feature
		// has been switched off by policy.
		return "This browser will not give the page access to a camera or microphone.";
	}

	return (
		`Cameras and microphones need a secure page, and ${hostname} is not one. ` +
		"Open the server on localhost, or put it behind HTTPS to reach it from here."
	);
}
