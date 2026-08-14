import type { Dictionary } from "../i18n";

/**
 * 日本語。
 *
 * ボタンやラベルは体言止め、説明文は「です・ます」。英語のほうも同じ加減で
 * 書かれている——謝らず、驚かず、起きたことと次にできることだけを言う。
 */
const ja: Dictionary = {
	"Ready to join?": "参加の準備はできましたか",
	"Check your camera and microphone first.": "先にカメラとマイクを確認してください。",
	"Your name": "名前",
	"Anybody who guesses this name can join. Names that were generated rather than chosen are not worth guessing at.":
		"この名前を言い当てた人は誰でも入れます。自動で作られた名前なら、言い当てられる心配はありません。",
	"Only an administrator can open a new room here. Type the name you were given.":
		"ここで新しいルームを開けるのは管理者だけです。教わったルーム名を入力してください。",
	Join: "参加",
	"Joining…": "参加しています…",
	"Joining as {name} with a signature only you can produce":
		"{name} として参加します。あなただけが作れる署名つきです",
	"Add {hash} and a passphrase to sign your name, so nobody else can appear under it.":
		"名前のうしろに {hash} と合言葉を付けると署名になり、ほかの人がその名前で現れなくなります。",

	"Cannot reach your devices": "デバイスに接続できません",
	"This browser will not give the page access to a camera or microphone.":
		"このブラウザは、カメラとマイクへのアクセスをページに許可しません。",
	"Cameras and microphones need a secure page, and {host} is not one. Open the server on localhost, or put it behind HTTPS to reach it from here.":
		"カメラとマイクには安全なページが必要ですが、{host} はそうではありません。localhost で開くか、HTTPS の内側に置いてからここへアクセスしてください。",

	"Room name": "ルーム名",
	"Change room": "ルームを変える",
	"Copy the link to this room": "このルームのリンクをコピー",
	"Link copied": "リンクをコピーしました",
	"Nobody else is here yet.": "まだほかに誰もいません。",

	Microphone: "マイク",
	Camera: "カメラ",
	Devices: "デバイス",
	"No devices found": "デバイスが見つかりません",
	"Device {number}": "デバイス {number}",
	Language: "言語",

	"Mute microphone": "マイクをオフにする",
	"Unmute microphone": "マイクをオンにする",
	"Turn camera off": "カメラをオフにする",
	"Turn camera on": "カメラをオンにする",
	"Show messages": "メッセージを表示",
	"Hide messages": "メッセージを隠す",
	Leave: "退出",

	"Share your screen": "画面を共有",
	"Stop sharing": "共有を停止",
	"Sharper text": "文字がくっきり",
	"Code, documents, slides": "コード、文書、スライド",
	"Smoother motion": "動きがなめらか",
	"Video, animation, a demonstration": "動画、アニメーション、操作の実演",
	"{name} is sharing": "{name} が共有しています",
	"Click to watch": "クリックして見る",

	"Their screen": "画面共有",
	"Their camera": "カメラ映像",
	"Fill the screen": "全画面にする",
	"Leave fullscreen": "全画面を終了",
	"Show everybody": "全員を表示",
	"Show {name} larger": "{name} を大きく表示",
	"Previous page": "前のページ",
	"Next page": "次のページ",

	"{name} (screen)": "{name}（画面）",
	"{name} (you)": "{name}（あなた）",
	unverified: "未確認",
	"A signature only this person can produce": "この人だけが作れる署名",
	"Given for this call. It says nothing about who they are":
		"この通話のために配られたもので、誰であるかは示しません",
	"Somebody else signed this name; this participant did not":
		"この名前には別の人の署名があり、この参加者にはありません",

	Messages: "メッセージ",
	"Close messages": "メッセージを閉じる",
	"Say something": "メッセージを入力",
	"Waiting for the connection": "接続を待っています",
	Send: "送信",
	"Messages last as long as the call. Nothing is written down.":
		"メッセージは通話のあいだだけ残り、記録はされません。",

	"{name} joined": "{name} が参加しました",
	"{name} left": "{name} が退出しました",
	"{name} started sharing": "{name} が共有を始めました",
	"Cannot reach your camera": "カメラに接続できません",
	"Cannot reach your microphone": "マイクに接続できません",
	"Allow it from the icon in the address bar, then try again.":
		"アドレスバーのアイコンから許可して、もう一度お試しください。",
	Sound: "音声",
	"Show sound": "音声パネルを開く",
	"Hide sound": "音声パネルを閉じる",
	"Close sound": "音声パネルを閉じる",
	"There is nobody else to hear.": "いま聞こえる相手はいません。",
	"microphone off": "マイクオフ",
	"How loud {name} is": "{name} の音量",
	"Stop hearing {name}": "{name} を聞かない",
	"Hear {name} again": "{name} をもう一度聞く",
	"You have stopped hearing this": "この音声は聞かない設定です",
	off: "オフ",
	"Nobody can be heard yet": "まだ誰の声も聞こえません",
	"This browser waits for a click before it will play sound.":
		"このブラウザは、一度クリックするまで音を再生しません。",
	"Turn on sound": "音を出す",

	"Connecting…": "接続しています…",
	"Reconnecting…": "再接続しています…",

	"Too many requests. Wait a moment and try again.":
		"リクエストが多すぎます。少し待ってからお試しください。",
	"Room names may only contain lowercase letters, digits, and inner dashes.":
		"ルーム名に使えるのは小文字、数字、そして中間のハイフンだけです。",
	"The server could not complete the request.": "サーバーがリクエストを完了できませんでした。",
	"Could not join {room}.": "{room} に参加できませんでした。",
	"{room} has not been opened. Ask whoever is holding the meeting for the link.":
		"{room} はまだ開かれていません。会議を開いている人にリンクを聞いてください。",
};

export default ja;
