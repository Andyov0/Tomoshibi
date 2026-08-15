import type { Dictionary } from "../i18n";

/**
 * 日本語。
 *
 * ボタンやラベルは体言止め、説明文は「です・ます」。英語のほうも同じ加減で
 * 書かれている——謝らず、驚かず、起きたことと次にできることだけを言う。
 */
const ja: Dictionary = {
	"Your name": "名前",
	"Passphrase": "合言葉",
	"Show passphrase": "合言葉を表示",
	"Hide passphrase": "合言葉を隠す",
	"Add a passphrase so nobody else can use your name.": "合言葉を付けると、ほかの人はこの名前を使えません。",
	"Anyone who guesses this name can join.": "この名前を言い当てた人は誰でも入れます。",
	"Only administrators can start new rooms. Enter the name you were given.": "新しいルームを開けるのは管理者だけです。教わったルーム名を入力してください。",
	Join: "参加",
	"Joining…": "参加しています…",
	"Only you can join as {name}": "{name} として参加できるのはあなただけです",

	"Can't use your camera or microphone": "カメラとマイクを使えません",
	"This browser blocks camera and microphone access.": "このブラウザはカメラとマイクへのアクセスを許可していません。",
	"Cameras and microphones need HTTPS, and {host} is not secure.": "カメラとマイクには HTTPS が必要ですが、{host} は安全な接続ではありません。",

	"Room name": "ルーム名",
	"Change room": "ルームを変える",
	"Copy link": "リンクをコピー",
	"Link copied": "リンクをコピーしました",

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
	"Video, animation, demos": "動画・アニメ・デモ",
	"{name} is sharing": "{name} が共有しています",
	"Watch": "見る",

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
	"Only this person can use this name": "この名前を使えるのはこの人だけです",
	"Anyone could use this name": "この名前は誰でも使えます",
	"Someone else has proved this name": "この名前はほかの人が証明しています",

	Messages: "メッセージ",
	"Close messages": "メッセージを閉じる",
	"Say something": "メッセージを入力",
	Send: "送信",
	"Messages disappear when the call ends.": "メッセージは通話が終わると消えます。",

	"{name} joined": "{name} が参加しました",
	"{name} left": "{name} が退出しました",
	"{name} started sharing": "{name} が共有を始めました",
	"Can't use your camera": "カメラを使えません",
	"Can't use your microphone": "マイクを使えません",
	"Allow access from the icon in the address bar.": "アドレスバーのアイコンから許可してください。",
	Sound: "音声",
	"Sound settings": "音声設定",
	"Copy signature": "署名をコピー",
	"Show sound": "音声パネルを開く",
	"Hide sound": "音声パネルを閉じる",
	"Close sound": "音声パネルを閉じる",
	"Nobody else is here.": "いまはあなただけです。",
	"microphone off": "マイクオフ",
	"{name}'s volume": "{name} の音量",
	"Mute {name}": "{name} をミュート",
	"Unmute {name}": "{name} のミュートを解除",
	"Muted by you": "あなたがミュートしています",
	"Muted": "ミュート",
	"You can't hear anyone yet": "まだ誰の声も聞こえません",
	"Your browser needs one click first.": "ブラウザが最初のクリックを待っています。",
	"Turn on sound": "音を出す",

	"Connecting…": "接続しています…",
	"Reconnecting…": "再接続しています…",

	"Too many attempts. Try again in a moment.": "回数が多すぎます。少し待ってからお試しください。",
	"Room names can only use lowercase letters, numbers and dashes.": "ルーム名に使えるのは小文字・数字・ハイフンだけです。",
	"Something went wrong. Try again.": "問題が起きました。もう一度お試しください。",
	"Could not join {room}.": "{room} に参加できませんでした。",
	"{room} isn't open. Ask the organiser for the link.": "{room} はまだ開かれていません。会議を開いている人にリンクを聞いてください。",
};

export default ja;
