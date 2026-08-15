import type { Dictionary } from "../i18n";

/**
 * 简体中文。
 *
 * 语气照英文原文的克制来:不用感叹号,不替人惊呼。出错时说清楚发生了什么、
 * 接下来能做什么,而不是道歉——"找不到你的摄像头"胜过"摄像头打开失败!"。
 */
const zhHans: Dictionary = {
	"Your name": "你的名字",
	"Passphrase": "口令",
	"Show passphrase": "显示口令",
	"Hide passphrase": "隐藏口令",
	"Add a passphrase so nobody else can use your name.": "加个口令，别人就用不了你的名字。",
	"Anyone who guesses this name can join.": "猜到这个名字的人都能进来。",
	"Only administrators can start new rooms. Enter the name you were given.": "只有管理员能开新房间。请填入别人给你的房间名。",
	Join: "加入",
	"Joining…": "正在加入…",
	"Only you can join as {name}": "只有你能用 {name} 加入",

	"Can't use your camera or microphone": "无法使用摄像头和麦克风",
	"This browser blocks camera and microphone access.": "这个浏览器不允许访问摄像头和麦克风。",
	"Cameras and microphones need HTTPS, and {host} is not secure.": "摄像头和麦克风需要 HTTPS，而 {host} 不是安全连接。",

	"Room name": "房间名",
	"Change room": "换个房间",
	"Copy link": "复制链接",
	"Link copied": "链接已复制",

	Microphone: "麦克风",
	Camera: "摄像头",
	Devices: "设备",
	"No devices found": "没有找到设备",
	"Device {number}": "设备 {number}",
	Language: "语言",

	"Mute microphone": "关闭麦克风",
	"Unmute microphone": "打开麦克风",
	"Turn camera off": "关闭摄像头",
	"Turn camera on": "打开摄像头",
	"Show messages": "显示消息",
	"Hide messages": "隐藏消息",
	Leave: "离开",

	"Share your screen": "共享屏幕",
	"Stop sharing": "停止共享",
	"Sharper text": "文字更锐利",
	"Code, documents, slides": "代码、文档、幻灯片",
	"Smoother motion": "画面更流畅",
	"Video, animation, demos": "视频、动画、演示",
	"{name} is sharing": "{name} 正在共享",
	"Watch": "查看",

	"Their screen": "对方屏幕",
	"Their camera": "对方摄像头",
	"Fill the screen": "全屏",
	"Leave fullscreen": "退出全屏",
	"Show everybody": "显示所有人",
	"Show {name} larger": "放大 {name}",
	"Previous page": "上一页",
	"Next page": "下一页",

	"{name} (screen)": "{name}（屏幕）",
	"{name} (you)": "{name}（你）",
	unverified: "未验证",
	"Only this person can use this name": "只有这个人能用这个名字",
	"Anyone could use this name": "谁都可以用这个名字",
	"Someone else has proved this name": "这个名字已经被别人证明过",

	Messages: "消息",
	"Close messages": "关闭消息",
	"Say something": "说点什么",
	Send: "发送",
	"Messages disappear when the call ends.": "通话结束后消息就没了。",

	"{name} joined": "{name} 加入了",
	"{name} left": "{name} 离开了",
	"{name} started sharing": "{name} 开始共享",
	"Can't use your camera": "无法使用你的摄像头",
	"Can't use your microphone": "无法使用你的麦克风",
	"Allow access from the icon in the address bar.": "在地址栏的图标里允许访问。",
	Sound: "声音",
	"Sound settings": "声音设置",
	"Copy signature": "复制签名",
	"Show sound": "打开声音面板",
	"Hide sound": "收起声音面板",
	"Close sound": "关闭声音面板",
	"Nobody else is here.": "现在只有你一个人。",
	"microphone off": "麦克风已关",
	"{name}'s volume": "{name} 的音量",
	"Mute {name}": "静音 {name}",
	"Unmute {name}": "取消静音 {name}",
	"Muted by you": "已被你静音",
	"Muted": "静音",
	"You can't hear anyone yet": "现在还听不到声音",
	"Your browser needs one click first.": "浏览器需要你先点一下。",
	"Turn on sound": "打开声音",

	"Connecting…": "正在连接…",
	"Reconnecting…": "正在重连…",

	"Too many attempts. Try again in a moment.": "尝试太频繁，请稍后再试。",
	"Room names can only use lowercase letters, numbers and dashes.": "房间名只能用小写字母、数字和连字符。",
	"Something went wrong. Try again.": "出了点问题，请重试。",
	"Could not join {room}.": "无法加入 {room}。",
	"{room} isn't open. Ask the organiser for the link.": "{room} 还没有开。请向开会的人要链接。",
};

export default zhHans;
