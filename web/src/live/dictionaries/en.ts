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
	"Ready to join?": "Ready to join?",
	"Check your camera and microphone first.": "Check your camera and microphone first.",
	"Your name": "Your name",
	"Anybody who guesses this name can join. Names that were generated rather than chosen are not worth guessing at.":
		"Anybody who guesses this name can join. Names that were generated rather than chosen are not worth guessing at.",
	"Only an administrator can open a new room here. Type the name you were given.":
		"Only an administrator can open a new room here. Type the name you were given.",
	Join: "Join",
	"Joining…": "Joining…",
	"Joining as {name} with a signature only you can produce":
		"Joining as {name} with a signature only you can produce",
	"Add {hash} and a passphrase to sign your name, so nobody else can appear under it.":
		"Add {hash} and a passphrase to sign your name, so nobody else can appear under it.",

	// A page that cannot reach a device at all.
	"Cannot reach your devices": "Cannot reach your devices",
	"This browser will not give the page access to a camera or microphone.":
		"This browser will not give the page access to a camera or microphone.",
	"Cameras and microphones need a secure page, and {host} is not one. Open the server on localhost, or put it behind HTTPS to reach it from here.":
		"Cameras and microphones need a secure page, and {host} is not one. Open the server on localhost, or put it behind HTTPS to reach it from here.",

	// The room, and its address.
	"Room name": "Room name",
	"Change room": "Change room",
	"Copy the link to this room": "Copy the link to this room",
	"Link copied": "Link copied",
	"Nobody else is here yet.": "Nobody else is here yet.",

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
	"Video, animation, a demonstration": "Video, animation, a demonstration",
	"{name} is sharing": "{name} is sharing",
	"Click to watch": "Click to watch",

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
	"A signature only this person can produce": "A signature only this person can produce",
	"Given for this call. It says nothing about who they are":
		"Given for this call. It says nothing about who they are",
	"Somebody else signed this name; this participant did not":
		"Somebody else signed this name; this participant did not",

	// Messages.
	Messages: "Messages",
	"Close messages": "Close messages",
	"Say something": "Say something",
	"Waiting for the connection": "Waiting for the connection",
	Send: "Send",
	"Messages last as long as the call. Nothing is written down.":
		"Messages last as long as the call. Nothing is written down.",

	// What is worth interrupting somebody for.
	"{name} joined": "{name} joined",
	"{name} left": "{name} left",
	"{name} started sharing": "{name} started sharing",
	"Cannot reach your camera": "Cannot reach your camera",
	"Cannot reach your microphone": "Cannot reach your microphone",
	"Allow it from the icon in the address bar, then try again.":
		"Allow it from the icon in the address bar, then try again.",
	"Nobody can be heard yet": "Nobody can be heard yet",
	"This browser waits for a click before it will play sound.":
		"This browser waits for a click before it will play sound.",
	"Turn on sound": "Turn on sound",

	// The connection, while it is not there.
	"Connecting…": "Connecting…",
	"Reconnecting…": "Reconnecting…",

	// What the server refused, said in the words of the person it refused.
	// The server sends a code; the sentence belongs here, with the others.
	"Too many requests. Wait a moment and try again.":
		"Too many requests. Wait a moment and try again.",
	"Room names may only contain lowercase letters, digits, and inner dashes.":
		"Room names may only contain lowercase letters, digits, and inner dashes.",
	"The server could not complete the request.": "The server could not complete the request.",
	"Could not join {room}.": "Could not join {room}.",
	"{room} has not been opened. Ask whoever is holding the meeting for the link.":
		"{room} has not been opened. Ask whoever is holding the meeting for the link.",
} as const;

export default en;
