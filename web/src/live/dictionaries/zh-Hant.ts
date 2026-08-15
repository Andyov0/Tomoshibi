import type { Dictionary } from "../i18n";

/**
 * 繁體中文。
 *
 * 與簡體分開維護，而不是轉一次字。兩者的差別不只在字形：螢幕與屏幕、
 * 影片與视频、訊息與消息、裝置與设备，都是各自習慣的說法，機器換字換不出來。
 */
const zhHant: Dictionary = {
	"Your name": "你的名字",
	"Passphrase": "密語",
	"Show passphrase": "顯示密語",
	"Hide passphrase": "隱藏密語",
	"Add a passphrase so nobody else can use your name.": "加個密語，別人就用不了你的名字。",
	"Anyone who guesses this name can join.": "猜到這個名字的人都能進來。",
	"Only administrators can start new rooms. Enter the name you were given.": "只有管理員能開新房間。請填入別人給你的房間名。",
	Join: "加入",
	"Joining…": "正在加入…",
	"Only you can join as {name}": "只有你能用 {name} 加入",

	"Can't use your camera or microphone": "無法使用攝影機和麥克風",
	"This browser blocks camera and microphone access.": "這個瀏覽器不允許存取攝影機和麥克風。",
	"Cameras and microphones need HTTPS, and {host} is not secure.": "攝影機和麥克風需要 HTTPS，而 {host} 不是安全連線。",

	"Room name": "房間名稱",
	"Change room": "換個房間",
	"Copy link": "複製連結",
	"Link copied": "連結已複製",

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
	"Video, animation, demos": "影片、動畫、示範",
	"{name} is sharing": "{name} 正在分享",
	"Watch": "查看",

	"Their screen": "對方螢幕",
	"Their camera": "對方攝影機",
	"Fill the screen": "全螢幕",
	"Leave fullscreen": "離開全螢幕",
	"Show everybody": "顯示所有人",
	"Show {name} larger": "放大 {name}",
	"Previous page": "上一頁",
	"Next page": "下一頁",

	"{name} (screen)": "{name}（螢幕）",
	"{name} (you)": "{name}（你）",
	unverified: "未驗證",
	"Only this person can use this name": "只有這個人能用這個名字",
	"Anyone could use this name": "誰都可以用這個名字",
	"Someone else has proved this name": "這個名字已經被別人證明過",

	Messages: "訊息",
	"Close messages": "關閉訊息",
	"Say something": "說點什麼",
	Send: "傳送",
	"Messages disappear when the call ends.": "通話結束後訊息就沒了。",

	"{name} joined": "{name} 加入了",
	"{name} left": "{name} 離開了",
	"{name} started sharing": "{name} 開始分享",
	"Can't use your camera": "無法使用你的攝影機",
	"Can't use your microphone": "無法使用你的麥克風",
	"Allow access from the icon in the address bar.": "在網址列的圖示裡允許存取。",
	Sound: "聲音",
	"Sound settings": "聲音設定",
	"Copy signature": "複製簽名",
	"Show sound": "打開聲音面板",
	"Hide sound": "收起聲音面板",
	"Close sound": "關閉聲音面板",
	"Nobody else is here.": "現在只有你一個人。",
	"microphone off": "麥克風已關",
	"{name}'s volume": "{name} 的音量",
	"Mute {name}": "靜音 {name}",
	"Unmute {name}": "取消靜音 {name}",
	"Muted by you": "已被你靜音",
	"Muted": "靜音",
	"You can't hear anyone yet": "現在還聽不到聲音",
	"Your browser needs one click first.": "瀏覽器需要你先點一下。",
	"Turn on sound": "開啟聲音",

	"Connecting…": "正在連線…",
	"Reconnecting…": "正在重新連線…",

	"Too many attempts. Try again in a moment.": "嘗試太頻繁，請稍後再試。",
	"Room names can only use lowercase letters, numbers and dashes.": "房間名只能用小寫字母、數字和連字號。",
	"Something went wrong. Try again.": "出了點問題，請重試。",
	"Could not join {room}.": "無法加入 {room}。",
	"{room} isn't open. Ask the organiser for the link.": "{room} 還沒有開。請向開會的人要連結。",
};

export default zhHant;
