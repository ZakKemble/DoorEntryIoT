#!/usr/bin/env node

/*
 * Project: Door Entry IoT
 * Author: Zak Kemble, contact@zakkemble.net
 * Copyright: (C) 2022 by Zak Kemble
 * License: 
 * Web: https://blog.zakkemble.net/iot-and-a-door-entry-system/
 */

// https://www.npmjs.com/package/websocket
// https://www.sohamkamani.com/blog/2016/09/21/making-a-telegram-bot/
// https://github.com/yagop/node-telegram-bot-api
// https://github.com/websockets/ws/blob/master/doc/ws.md


import dotenv from "dotenv";
dotenv.config();

import http from "http";
import TelegramBot from "node-telegram-bot-api";
import { readFileSync, writeFile } from "fs";
import util from "util";
import stuff from "./stuff.js";

let whitelist = null;
try
{
	const data = readFileSync("./whitelist.json");
	whitelist = JSON.parse(data);
}
catch (err)
{
	if(err.code === "ENOENT") // File not found
		whitelist = {};
	else
	{
		stuff.consoleError(err);
		process.exit(1);
	}
}
stuff.consoleLog(whitelist);

const bot = new TelegramBot(process.env.TG_TOKEN, {polling: true});
let autoUnlockTimer = null;


stuff.start({
	onStart: () => {
		sendGroupMessage("\u{1F6A8} *Door entry bot server online*");
	},
	onSession: (ws, object, isNew) => {
		sendGroupMessage(util.format("\u{1F64C} *Intercom %sconnected* (\#%d %s)", ((isNew == true) ? "" : "re"), ws.clientId, ws.session.id));
	},
	onSessionEnd: (session) => {
		sendGroupMessage(util.format("DEBUG: Session timeout %s", session.id));
	},
	onMessage: onMessage,
	onClose: (ws, code, reason) => {
		sendGroupMessage(util.format("DEBUG: Intercom disconnected (\#%d %d)", ws.clientId, code));
	},
	onError: (msg) => {
		sendGroupMessage(msg, {});
	},
	auth: {
		user: process.env.AUTH_USER,
		pass: process.env.AUTH_PASS
	},
	http_port: process.env.HTTP_PORT
});

function doorUnlock(name, isAutoUnlock = false)
{
	stuff.sendAll(
		{
			action: "unlock",
			duration: process.env.UNLOCK_DURATION
		},
		{
			name: name,
			isAutoUnlock: isAutoUnlock
		}
	);
}

function sendGroupMessage(message, opts = {parse_mode: "markdown"})
{
	bot.sendMessage(process.env.TG_CHATID, message, opts);
}

function onMessage(ws, object, request)
{
	if(object.notify === "ring")
	{
		if(autoUnlockTimer != null)
		{
			clearTimeout(autoUnlockTimer);
			autoUnlockTimer = null;
			//sendGroupMessage("\u{1F513} *Door auto-unlocked*");
			doorUnlock("", true);
		}
		else
		{
			// Tell group chat that the door bell has been rang, also add an inline keyboard

			// Keyboard config
			const opts = {
				parse_mode: "markdown",
				reply_markup: {
					inline_keyboard: [
						[
							{
								text: "Unlock",
								callback_data: "unlock"
							}
						]
					]
				}
			};

			const message = "\u{1F6AA} *Someone is at the door!*";
			sendGroupMessage(message, opts);
		}
	}
	else if(object.notify === "unlocked")
	{
		let msg;
		if(request === null)
			msg = "\u{1F513} *(Unknown) unlocked the door!*"
		else if(request.data.isAutoUnlock)
			msg = "\u{1F513} *Door auto-unlocked*";
		else
			msg = util.format("\u{1F513} *%s unlocked the door!*", request.data.name);

		sendGroupMessage(msg);
	}
	else if(object.notify === "neighbor")
	{
		sendGroupMessage(util.format("\u{1F513} *A neighbor unlocked the door!*"));
	}
	else if(object.notify === "status")
	{
		if(request !== null)
		{
			const message = util.format(
				"\u{2139} *STATUS*\n" +
				"*Uptime:* %dms\n" +
				"*WiFi Conns:* %d\n" +
				"*WebSocket Conns:* %d\n" +
				"*Rings:* %d\n" +
				"*Unlocks:* %d\n" +
				"*Neighbour:* %d\n" +
				"*Stuck:* %d\n" +
				"*IP:* %s\n" +
				"*Subnet:* %s\n" +
				"*Gateway:* %s\n" +
				"*DNS1:* %s\n" +
				"*DNS2:* %s\n" +
				"*Hostname:* %s\n" +
				"*MAC:* %s\n" +
				"*SSID:* %s\n" +
				"*BSSID:* %s\n" +
				"*Channel:* %d\n" +
				"*RSSI:* %ddBi\n" +
				"*Temperature:* %s\u{00B0}C\n" +
				"*Humidity:* %s%%",
				object.millis,
				object.counts.wifi,
				object.counts.ws,
				object.counts.ring,
				object.counts.unlock,
				object.counts.neighbour,
				object.counts.stuck,
				object.net.ip,
				object.net.subnet,
				object.net.gateway,
				object.net.dns1,
				object.net.dns2,
				object.net.hostname,
				object.wifi.mac,
				object.wifi.ssid,
				object.wifi.bssid,
				object.wifi.channel,
				object.wifi.rssi,
				object.env.t.toFixed(2),
				object.env.h.toFixed(2)
			);

			bot.sendMessage(request.data.chatId, message, {parse_mode: "markdown"});
		}
		else
		{
			stuff.consoleLog("Invalid status request ID %s", object.requestId);
			sendGroupMessage(util.format("Invalid status request ID %s", object.requestId), {});
		}
	}
	else if(object.notify === "stuck")
	{
		sendGroupMessage(util.format("\u{1F914} *Is something stuck?*"));
	}
	else if(object.notify === "unstuck")
	{
		sendGroupMessage(util.format("\u{1F60C} *It's unstuck now*"));
	}
	else
	{
		stuff.consoleLog("Unknown notify: %s", object.notify);
		sendGroupMessage(util.format("DEBUG: Unknown notify: %s", object.notify), {});
	}
}

// Handle callback queries
// This handles inline keyboard presses from the group chat
bot.on("callback_query", (callbackQuery) => {
	const action = callbackQuery.data;
	const msg = callbackQuery.message;
	stuff.consoleLog(callbackQuery);
	
	stuff.consoleLog("Got TG callback: " + action);

	if (action === "unlock" || action === "unlock_noedit")
	{
		// TODO wait for an OK response before sending a message to say "blah unlocked"
		// retry a few times if timeout
		// will need an ID so it doesnt do a duplicate open action

		// TODO @ing the bot should allow sending commands in the group chat
		// /unlock
		// /status

		doorUnlock(callbackQuery.from.first_name);
		
		if(action === "unlock")
		{
			const message = util.format("\u{1F6AA} *Someone is at the door!* (%s Unlocked)", callbackQuery.from.first_name);

			const opts = {
				chat_id: msg.chat.id,
				message_id: msg.message_id,
				parse_mode: "markdown",
				reply_markup: {
					inline_keyboard: [
						[
							{
								text: "Unlocked",
								callback_data: "unlock_noedit"
							}
						]
					]
				}
			};

			bot.editMessageText(message, opts);
		}
		
		const opts = {
			text: "Unlocked for 3 seconds!",
			show_alert: false,
			cache_time: 0
		};
		bot.answerCallbackQuery(callbackQuery.id, opts);
		//sendGroupMessage("\u{1F513} *" + callbackQuery.from.first_name + " Unlocked!*");
		stuff.consoleLog("Answered TG query");
	}
	else
	{
		sendGroupMessage(util.format("DEBUG: Unknown callback query %s", action), {});
		bot.answerCallbackQuery(callbackQuery.id);
		stuff.consoleLog("Unknown TG query %s", action);
	}
});

// This handles TG bot receiving direct messages
bot.on("text", (message) => {

	stuff.consoleLog(message);
	
	// TODO
	// first_name, last_name and username can be undefined
	
	const userId = message.from.id;
	const chatId = message.chat.id;
	const name = message.from.first_name;
	const isDM = (message.chat.type == "private");
	const msg = message.text.toLowerCase().split("@")[0]; // Split removes stuff after the first @ symbol

	const secret = msg.includes(process.env.WHITELIST_PASS);
	if(secret)
		bot.sendMessage(chatId, "Accepted!", {});

	if(!whitelist.hasOwnProperty(userId))
	{
		if(!isDM)
			return;
		else if(!secret)
		{
			bot.sendMessage(chatId, util.format("Who dis? (%d)", userId), {});
			sendGroupMessage(util.format("An unknown user is talking to the dog! %s - %s", message.from.username, message.text), {});
			return;
		}
		else
		{
			whitelist[userId] = {
				"name": name,
				"added": stuff.formatFullDateTime()
			};
			const data = JSON.stringify(whitelist);
			
			// TODO this is async, should wait for the promise to resolve before writing again
			writeFile("./whitelist.json", data, (err) => {
				if(err)
					stuff.consoleError(err.message);
			});
			
			sendGroupMessage(util.format("New user registered: %s", name), {});
		}
	}

	// Keyboard config
	const opts = {
		reply_markup: {
			resize_keyboard: true,
			keyboard: [
				[
					{
						text: "Unlock"
					}
				],
				[
					{
						text: "Auto-unlock"
					}
				]
			],
			
		}
	};

	if(msg === "unlock" || msg === "/unlock")
	{
		// Send door unlock action to all connected notifiers
		doorUnlock(name);

		// Reply to message sender
		if(isDM)
			bot.sendMessage(chatId, "Unlocked for 3 seconds!", opts);
		
		// Send message to group
		//sendGroupMessage("\u{1F513} *" + message.from.first_name + " unlocked!*");
	}
	else if(msg === "auto-unlock" || msg === "autounlock" || msg === "/autounlock")
	{
		if(isDM)
			bot.sendMessage(chatId, "Auto-unlock enabled for 5 minutes", opts);
		sendGroupMessage(util.format("Auto-unlock enabled by %s for 5 minutes", name), {});

		clearTimeout(autoUnlockTimer);
		autoUnlockTimer = setTimeout(() => {
			autoUnlockTimer = null;
			sendGroupMessage("Auto-unlock timer expired", {});
		}, process.env.AUTOUNLOCK_TIME);
	}
	else if(msg === "status")
	{
		stuff.sendAll({action: "status"}, {chatId: chatId});
	}
	else
		bot.sendMessage(chatId, "OwO", opts);
});

bot.on("sticker", (message) => {
	stuff.consoleLog(message);
});

bot.on("polling_error", (error) => {
	stuff.consoleError(error)
});

bot.on("webhook_error", (error) => {
	stuff.consoleError(error)
});
