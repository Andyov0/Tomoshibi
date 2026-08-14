import type { Dictionary } from "../i18n";

/**
 * 简体中文。
 *
 * 语气照英文原文的克制来:不用感叹号,不替人惊呼。出错时说清楚发生了什么、
 * 接下来能做什么,而不是道歉——"找不到你的摄像头"胜过"摄像头打开失败!"。
 */
const zhHans: Dictionary = {
	"Ready to join?": "准备好了吗？",
	"Check your camera and microphone first.": "先检查一下摄像头和麦克风。",
	"Your name": "你的名字",
	Join: "加入",
	"Joining…": "正在加入…",
	"Joining as {name} with a signature only you can produce":
		"以 {name} 加入，带着只有你能产生的签名",
	"Add {hash} and a passphrase to sign your name, so nobody else can appear under it.":
		"在名字后加 {hash} 和一个口令来签名，别人就无法用它出现。",

	"Cannot reach your devices": "无法访问你的设备",
	"This browser will not give the page access to a camera or microphone.":
		"这个浏览器不会把摄像头和麦克风交给本页面。",
	"Cameras and microphones need a secure page, and {host} is not one. Open the server on localhost, or put it behind HTTPS to reach it from here.":
		"摄像头和麦克风需要安全页面，而 {host} 不是。请在 localhost 上打开，或者给它加上 HTTPS 之后再从这里访问。",

	"Room name": "房间名",
	"Change room": "换个房间",
	"Copy the link to this room": "复制这个房间的链接",
	"Link copied": "链接已复制",
	"Nobody else is here yet.": "还没有其他人。",

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
	"Video, animation, a demonstration": "视频、动画、操作演示",
	"{name} is sharing": "{name} 正在共享",
	"Click to watch": "点击观看",

	"Their screen": "屏幕画面",
	"Their camera": "摄像头画面",
	"Fill the screen": "全屏",
	"Leave fullscreen": "退出全屏",
	"Show everybody": "显示所有人",
	"Show {name} larger": "放大 {name}",
	"Previous page": "上一页",
	"Next page": "下一页",

	"{name} (screen)": "{name}（屏幕）",
	"{name} (you)": "{name}（你）",
	unverified: "未验证",
	"A signature only this person can produce": "只有此人能产生的签名",
	"Given for this call. It says nothing about who they are":
		"本次通话临时分配。它不说明这个人是谁",
	"Somebody else signed this name; this participant did not":
		"有人为这个名字签过名，而此人没有",

	Messages: "消息",
	"Close messages": "关闭消息",
	"Say something": "说点什么",
	"Waiting for the connection": "等待连接",
	Send: "发送",
	"Messages last as long as the call. Nothing is written down.":
		"消息只在通话期间存在，不会被记录下来。",

	"{name} joined": "{name} 加入了",
	"{name} left": "{name} 离开了",
	"{name} started sharing": "{name} 开始共享",
	"Cannot reach your camera": "找不到你的摄像头",
	"Cannot reach your microphone": "找不到你的麦克风",
	"Allow it from the icon in the address bar, then try again.":
		"在地址栏的图标里允许它，然后再试一次。",
	"Nobody can be heard yet": "还听不到任何人",
	"This browser waits for a click before it will play sound.":
		"这个浏览器要先有一次点击才会播放声音。",
	"Turn on sound": "打开声音",

	"Connecting…": "正在连接…",
	"Reconnecting…": "正在重连…",

	"Too many requests. Wait a moment and try again.": "请求太频繁。稍等一下再试。",
	"Room names may only contain lowercase letters, digits, and inner dashes.":
		"房间名只能包含小写字母、数字，以及中间的连字符。",
	"The server could not complete the request.": "服务器无法完成这个请求。",
	"Could not join {room}.": "无法加入 {room}。",
};

export default zhHans;
