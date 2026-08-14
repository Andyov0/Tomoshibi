import type { Dictionary } from "../i18n";

/**
 * 繁體中文。
 *
 * 與簡體分開維護，而不是轉一次字。兩者的差別不只在字形：螢幕與屏幕、
 * 影片與视频、訊息與消息、裝置與设备，都是各自習慣的說法，機器換字換不出來。
 */
const zhHant: Dictionary = {
	"Ready to join?": "準備好了嗎？",
	"Check your camera and microphone first.": "先檢查一下攝影機和麥克風。",
	"Your name": "你的名字",
	"Anybody who guesses this name can join. Names that were generated rather than chosen are not worth guessing at.":
		"猜到這個名字的人都能進來。隨機產生的名字不值得去猜。",
	"Only an administrator can open a new room here. Type the name you were given.":
		"這裡只有管理員能開新房間。請填入別人給你的房間名。",
	Join: "加入",
	"Joining…": "正在加入…",
	"Joining as {name} with a signature only you can produce":
		"以 {name} 加入，帶著只有你能產生的簽名",
	"Add {hash} and a passphrase to sign your name, so nobody else can appear under it.":
		"在名字後加 {hash} 和一組密語來簽名，別人就無法用它出現。",

	"Cannot reach your devices": "無法存取你的裝置",
	"This browser will not give the page access to a camera or microphone.":
		"這個瀏覽器不會把攝影機和麥克風交給本頁面。",
	"Cameras and microphones need a secure page, and {host} is not one. Open the server on localhost, or put it behind HTTPS to reach it from here.":
		"攝影機和麥克風需要安全頁面，而 {host} 不是。請在 localhost 上開啟，或者為它加上 HTTPS 之後再從這裡存取。",

	"Room name": "房間名稱",
	"Change room": "換個房間",
	"Copy the link to this room": "複製這個房間的連結",
	"Link copied": "連結已複製",
	"Nobody else is here yet.": "還沒有其他人。",

	Microphone: "麥克風",
	Camera: "攝影機",
	Devices: "裝置",
	"No devices found": "找不到裝置",
	"Device {number}": "裝置 {number}",
	Language: "語言",

	"Mute microphone": "關閉麥克風",
	"Unmute microphone": "開啟麥克風",
	"Turn camera off": "關閉攝影機",
	"Turn camera on": "開啟攝影機",
	"Show messages": "顯示訊息",
	"Hide messages": "隱藏訊息",
	Leave: "離開",

	"Share your screen": "分享螢幕",
	"Stop sharing": "停止分享",
	"Sharper text": "文字更銳利",
	"Code, documents, slides": "程式碼、文件、簡報",
	"Smoother motion": "畫面更流暢",
	"Video, animation, a demonstration": "影片、動畫、操作示範",
	"{name} is sharing": "{name} 正在分享",
	"Click to watch": "點擊觀看",

	"Their screen": "螢幕畫面",
	"Their camera": "攝影機畫面",
	"Fill the screen": "全螢幕",
	"Leave fullscreen": "離開全螢幕",
	"Show everybody": "顯示所有人",
	"Show {name} larger": "放大 {name}",
	"Previous page": "上一頁",
	"Next page": "下一頁",

	"{name} (screen)": "{name}（螢幕）",
	"{name} (you)": "{name}（你）",
	unverified: "未驗證",
	"A signature only this person can produce": "只有此人能產生的簽名",
	"Given for this call. It says nothing about who they are":
		"本次通話臨時配發。它不說明這個人是誰",
	"Somebody else signed this name; this participant did not":
		"有人為這個名字簽過名，而此人沒有",

	Messages: "訊息",
	"Close messages": "關閉訊息",
	"Say something": "說點什麼",
	"Waiting for the connection": "等待連線",
	Send: "傳送",
	"Messages last as long as the call. Nothing is written down.":
		"訊息只在通話期間存在，不會被記錄下來。",

	"{name} joined": "{name} 加入了",
	"{name} left": "{name} 離開了",
	"{name} started sharing": "{name} 開始分享",
	"Cannot reach your camera": "找不到你的攝影機",
	"Cannot reach your microphone": "找不到你的麥克風",
	"Allow it from the icon in the address bar, then try again.":
		"在網址列的圖示裡允許它，然後再試一次。",
	"Nobody can be heard yet": "還聽不到任何人",
	"This browser waits for a click before it will play sound.":
		"這個瀏覽器要先有一次點擊才會播放聲音。",
	"Turn on sound": "開啟聲音",

	"Connecting…": "正在連線…",
	"Reconnecting…": "正在重新連線…",

	"Too many requests. Wait a moment and try again.": "請求太頻繁。稍等一下再試。",
	"Room names may only contain lowercase letters, digits, and inner dashes.":
		"房間名稱只能包含小寫字母、數字，以及中間的連字號。",
	"The server could not complete the request.": "伺服器無法完成這個請求。",
	"Could not join {room}.": "無法加入 {room}。",
	"{room} has not been opened. Ask whoever is holding the meeting for the link.":
		"{room} 還沒有開。請向開會的人要連結。",
};

export default zhHant;
