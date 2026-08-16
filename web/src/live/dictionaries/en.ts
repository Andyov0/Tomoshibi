/**
 * Everything the interface says, in the language it was written in.
 *
 * This file is the vocabulary. A phrase that is not here cannot be said, and
 * every other dictionary is checked against it — a missing entry and an entry
 * for something no longer said both fail the same test.
 *
 * The values are identical to the keys, and that is the point rather than
 * duplication: the key is the English, so English needs no translation, and any
 * phrase a translator has not reached yet falls back to a whole readable
 * sentence instead of a dotted path.
 */
const en = {
	// Joining.
	"Your name": "Your name",
	"Passphrase": "Passphrase",
	"Show passphrase": "Show passphrase",
	"Hide passphrase": "Hide passphrase",
	"Add a passphrase so nobody else can use your name.":
		"Add a passphrase so nobody else can use your name.",
	"Anyone who guesses this name can join.":
		"Anyone who guesses this name can join.",
	"Only administrators can start new rooms. Enter the name you were given.":
		"Only administrators can start new rooms. Enter the name you were given.",
	Join: "Join",
	"Joining…": "Joining…",
	"Only you can join as {name}":
		"Only you can join as {name}",

	// A page that cannot reach a device at all.
	"Can't use your camera or microphone": "Can't use your camera or microphone",
	"This browser blocks camera and microphone access.":
		"This browser blocks camera and microphone access.",
	"Cameras and microphones need HTTPS, and {host} is not secure.":
		"Cameras and microphones need HTTPS, and {host} is not secure.",

	// The room, and its address.
	"Room name": "Room name",
	"Change room": "Change room",
	"Copy link": "Copy link",
	"Link copied": "Link copied",

	// Devices.
	Microphone: "Microphone",
	Camera: "Camera",
	Devices: "Devices",
	"No devices found": "No devices found",
	"Device {number}": "Device {number}",
	Language: "Language",

	// The controls.
	"Mute microphone": "Mute microphone",
	"Unmute microphone": "Unmute microphone",
	"Turn camera off": "Turn camera off",
	"Turn camera on": "Turn camera on",
	"Show messages": "Show messages",
	"Hide messages": "Hide messages",
	Leave: "Leave",

	// Sharing a screen.
	"Share your screen": "Share your screen",
	"Stop sharing": "Stop sharing",
	"Sharper text": "Sharper text",
	"Code, documents, slides": "Code, documents, slides",
	"Smoother motion": "Smoother motion",
	"Video, animation, demos": "Video, animation, demos",
	"{name} is sharing": "{name} is sharing",
	"Watch": "Watch",

	// The stage.
	"Their screen": "Their screen",
	"Their camera": "Their camera",
	"Fill the screen": "Fill the screen",
	"Leave fullscreen": "Leave fullscreen",
	"Show everybody": "Show everybody",
	"Show {name} larger": "Show {name} larger",
	"Previous page": "Previous page",
	"Next page": "Next page",

	// What a picture is labelled with.
	"{name} (screen)": "{name} (screen)",
	"{name} (you)": "{name} (you)",
	unverified: "unverified",
	"Only this person can use this name": "Only this person can use this name",
	"Anyone could use this name":
		"Anyone could use this name",
	"Someone else has proved this name":
		"Someone else has proved this name",

	// Messages.
	Messages: "Messages",
	"Close messages": "Close messages",
	"Say something": "Say something",
	Send: "Send",
	"Messages disappear when the call ends.":
		"Messages disappear when the call ends.",

	// What is worth interrupting somebody for.
	"{name} joined": "{name} joined",
	"{name} left": "{name} left",
	"{name} started sharing": "{name} started sharing",
	"Can't use your camera": "Can't use your camera",
	"Can't use your microphone": "Can't use your microphone",
	"Allow access from the icon in the address bar.":
		"Allow access from the icon in the address bar.",
	// Sound, which is one person's own decision about everybody else.
	Sound: "Sound",
	"Sound settings": "Sound settings",
	"Copy signature": "Copy signature",
	"Show sound": "Show sound",
	"Hide sound": "Hide sound",
	"Close sound": "Close sound",
	"Nobody else is here.": "Nobody else is here.",
	"microphone off": "microphone off",
	"{name}'s volume": "{name}'s volume",
	"Mute {name}": "Mute {name}",
	"Unmute {name}": "Unmute {name}",
	"Muted by you": "Muted by you",
	"Muted": "Muted",
	"You can't hear anyone yet": "You can't hear anyone yet",
	"Your browser needs one click first.":
		"Your browser needs one click first.",
	"Turn on sound": "Turn on sound",
	"Dismiss": "Dismiss",

	// The connection, while it is not there.
	"Connecting…": "Connecting…",
	"Reconnecting…": "Reconnecting…",

	// What the server refused, said in the words of the person it refused.
	// The server sends a code; the sentence belongs here, with the others.
	"Too many attempts. Try again in a moment.":
		"Too many attempts. Try again in a moment.",
	"Room names can only use lowercase letters, numbers and dashes.":
		"Room names can only use lowercase letters, numbers and dashes.",
	"Something went wrong. Try again.": "Something went wrong. Try again.",
	"Could not join {room}.": "Could not join {room}.",
	"{room} isn't open. Ask the organiser for the link.":
		"{room} isn't open. Ask the organiser for the link.",

	Relays: "Relays",
	"Where calls are held. This machine serves the page and carries no media.": "Where calls are held. This machine serves the page and carries no media.",
	"Add relay": "Add relay",
	"No relays yet. Calls cannot be held until one is added.": "No relays yet. Calls cannot be held until one is added.",
	"Not taking new calls": "Not taking new calls",
	"Answered in {ms} ms": "Answered in {ms} ms",
	"Did not answer: {reason}": "Did not answer: {reason}",
	"Did not answer": "Did not answer",
	"Stop sending here": "Stop sending here",
	"Send calls here": "Send calls here",
	Remove: "Remove",
	Cancel: "Cancel",
	"Remove relay": "Remove relay",
	"Calls already on this relay keep running; this only stops new ones being sent there.": "Calls already on this relay keep running; this only stops new ones being sent there.",
	Name: "Name",
	Address: "Address",
	"Region (optional)": "Region (optional)",
	"The address a browser dials. It must begin ws:// or wss://, and the relay must be running with role: relay.": "The address a browser dials. It must begin ws:// or wss://, and the relay must be running with role: relay.",
	"Add a machine": "Add a machine",
	"Add by address": "Add by address",
	"Paste this into the new machine as root. It asks for a prefix, then does the rest: fetches the binary, takes this deployment's certificate and credentials, points a name at the machine, and starts the relay.": "Paste this into the new machine as root. It asks for a prefix, then does the rest: fetches the binary, takes this deployment's certificate and credentials, points a name at the machine, and starts the relay.",
	"This script carries the key to this deployment. Anybody who has it can add a relay, so do not put it anywhere it will be kept.": "This script carries the key to this deployment. Anybody who has it can add a relay, so do not put it anywhere it will be kept.",
	"This deployment cannot bring up relays from a script.": "This deployment cannot bring up relays from a script.",
	"Could not copy. Select the text and copy it.": "Could not copy. Select the text and copy it.",
	Copy: "Copy",
	Copied: "Copied",
	Done: "Done",
	Quality: "Quality",
	Standard: "Standard",
	High: "High",
	Ultra: "Ultra",
	"1080p, up to 8 Mbps": "1080p, up to 8 Mbps",
	"1440p, up to 16 Mbps": "1440p, up to 16 Mbps",
	"4K, up to 30 Mbps. Needs a fast machine and upload.": "4K, up to 30 Mbps. Needs a fast machine and upload.",
} as const;

export default en;
