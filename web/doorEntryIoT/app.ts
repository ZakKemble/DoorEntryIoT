/*
 * Project: Door Entry System IoT
 * Author: Zak Kemble, contact@zakkemble.net
 * Copyright: (C) 2022 by Zak Kemble
 * License: 
 * Web: https://blog.zakkemble.net/iot-and-a-door-entry-system/
 */

import dotenv from "dotenv";
dotenv.config();

// Env defaults
[
	["TG_TOKEN", ""],
	["TG_CHATID", ""],
	["AUTH_USER", "user"],
	["AUTH_PASS", "pass"],
	["HTTP_PORT", 8080],
	["WHITELIST_PASS", "pass"],
	["UNLOCK_DURATION", 3000],
	["AUTOUNLOCK_TIME", 300000]

].forEach((val) => {
	process.env[val[0]] ??= val[1].toString();
});

import http from "node:http";
import util from "node:util";
import { readFileSync, writeFile } from "node:fs";
import TelegramBot from "node-telegram-bot-api";
import logger from "./logger";
import { DoorEntry } from "./DoorEntry";


class Timer
{
	private timer: NodeJS.Timeout;
	private isActive: boolean = false;

	constructor(callback: (args: void) => void, timeout: number)
	{
		this.timer = setTimeout(() => {
			if(this.isActive)
			{
				this.isActive = false;
				callback();
			}
		}, timeout);
	}

	start()
	{
		this.timer.refresh();
		this.isActive = true;
	}

	active()
	{
		return this.isActive;
	}

	stop()
	{
		this.isActive = false;
	}
}


let whitelist: DoorEntry.Whitelist = {};
try
{
	whitelist = JSON.parse(readFileSync("./whitelist.json").toString());
}
catch (err:any)
{
	if(err.code != "ENOENT") // ENOENT = File not found
	{
		// File found, but there was some other kind of error
		logger.error(err);
		process.exit(1);
	}
}
logger.info(whitelist);


// The websocket server
const svr = new DoorEntry.Server(
	+process.env.HTTP_PORT!,
	process.env.AUTH_USER!,
	process.env.AUTH_PASS!
);

const bot = new TelegramBot(
	process.env.TG_TOKEN!,
	{
		polling: true
	}
);

const autoUnlockTimer = new Timer(() => {
	sendGroupMessage("Auto-unlock timer expired", {});
}, +process.env.AUTOUNLOCK_TIME!);


process.once("SIGINT", () => {sendGroupMessage("Server shutdown SIGINT")});
process.once("SIGTERM", () => {sendGroupMessage("Server shutdown SIGTERM")});


function doorUnlock(name: string, isAutoUnlock = false)
{
	const serverData = {
		name: name,
		isAutoUnlock: isAutoUnlock
	};

	svr.clients.forEach((ws) => {
		(ws as DoorEntry.Device).open(+process.env.UNLOCK_DURATION!, serverData);
	});
}

function sendGroupMessage(message: string, opts: TelegramBot.SendMessageOptions = {parse_mode: "Markdown"})
{
	bot.sendMessage(process.env.TG_CHATID!, message, opts);
}


svr.on("start", () => {
	sendGroupMessage("\u{1F6A8} *Door entry bot server online*");
});

svr.on("timeout", (session: DoorEntry.Session) => {
	sendGroupMessage(util.format("DEBUG: Session timeout %s", session.id));
});

svr.on("device", (dev: DoorEntry.Device, isNewConnection: boolean) => {
	sendGroupMessage(util.format("\u{1F64C} *Intercom %sconnected* (\#%d %s)", (isNewConnection ? "" : "re"), dev.clientId, dev.session?.id ?? "-"));

	dev.on("ring", (object: DoorEntry.IMessage, request: DoorEntry.Request) => {
		if(autoUnlockTimer.active())
		{
			autoUnlockTimer.stop();
			//sendGroupMessage("\u{1F513} *Door auto-unlocked*");
			doorUnlock("", true);
		}
		else
		{
			// Tell group chat that the door bell has been rang, also add an inline keyboard

			// Keyboard config
			const opts:TelegramBot.SendMessageOptions = {
				parse_mode: "Markdown",
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

			sendGroupMessage("\u{1F6AA} *Someone is at the door!*", opts);
		}
	});

	dev.on("unlocked", (object: DoorEntry.IMessage, request: DoorEntry.Request) => {
		let msg;
		if(request == null)
			msg = "\u{1F513} *(Unknown) unlocked the door!*"
		else if(request.data.isAutoUnlock)
			msg = "\u{1F513} *Door auto-unlocked*";
		else
			msg = util.format("\u{1F513} *%s unlocked the door!*", request.data.name);

		sendGroupMessage(msg);
	});

	dev.on("neighbor", (object: DoorEntry.IMessage, request: DoorEntry.Request) => {
		sendGroupMessage(util.format("\u{1F513} *A neighbor unlocked the door!*"));
	});

	dev.on("status", (object: DoorEntry.IMessage, request: DoorEntry.Request) => {
		if(request != null)
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

			bot.sendMessage(request.data.chatId, message, {parse_mode: "Markdown"});
		}
		else
		{
			logger.info("Invalid status request ID %s", object.requestId);
			sendGroupMessage(util.format("Invalid status request ID %s", object.requestId), {});
		}
	});

	dev.on("stuck", (object: DoorEntry.IMessage, request: DoorEntry.Request) => {
		sendGroupMessage(util.format("\u{1F914} *Is something stuck?*"));
	});

	dev.on("unstuck", (object: DoorEntry.IMessage, request: DoorEntry.Request) => {
		sendGroupMessage(util.format("\u{1F60C} *It's unstuck now*"));
	});

	//dev.on("doorbell", (object: DoorEntry.IMessage, request: DoorEntry.Request) => {
	//	sendGroupMessage(util.format("\u{1F514} *Someone rang the doorbell!*"));
	//});

	dev.on("unknown", (object: DoorEntry.IMessage, request: DoorEntry.Request) => {
		logger.info("Unknown notify: %s", object.notify);
		sendGroupMessage(util.format("DEBUG: Unknown notify: %s", object.notify), {});
	});

	dev.on("close", (code: number, reason: string) => {
		sendGroupMessage(util.format("DEBUG: Intercom disconnected (\#%d %d)", dev.clientId, code));
	});

	dev.on("error", (err) => {
		sendGroupMessage(err.message, {});
	});
});


// Handle callback queries
// This handles inline keyboard presses from the group chat
bot.on("callback_query", (callbackQuery) => {
	const action = callbackQuery.data;
	const msg = callbackQuery.message;

	logger.info(callbackQuery);
	logger.info("Got TG callback: " + action);

	if (msg && (action == "unlock" || action == "unlock_noedit"))
	{
		// TODO wait for an OK response before sending a message to say "blah unlocked"
		// retry a few times if timeout
		// will need an ID so it doesnt do a duplicate open action

		// TODO @ing the bot should allow sending commands in the group chat
		// /unlock
		// /status

		doorUnlock(callbackQuery.from.first_name);
		
		if(action == "unlock")
		{
			const opts: TelegramBot.EditMessageTextOptions = {
				chat_id: msg.chat.id,
				message_id: msg.message_id,
				parse_mode: "Markdown",
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

			bot.editMessageText(util.format("\u{1F6AA} *Someone is at the door!* (%s Unlocked)", callbackQuery.from.first_name), opts);
		}
		
		const opts = {
			text: "Unlocked for 3 seconds!",
			show_alert: false,
			cache_time: 0
		};
		bot.answerCallbackQuery(callbackQuery.id, opts);
		//sendGroupMessage("\u{1F513} *" + callbackQuery.from.first_name + " Unlocked!*");
		logger.info("Answered TG query");
	}
	else
	{
		sendGroupMessage(util.format("DEBUG: Unknown callback query %s", action), {});
		bot.answerCallbackQuery(callbackQuery.id);
		logger.info("Unknown TG query %s", action);
	}
});

// This handles TG bot receiving direct messages
bot.on("text", (message) => {

	logger.info(message);

	if(!message.from || !message.text)
		return;

	const userId = message.from.id;
	const chatId = message.chat.id;
	const name = message.from.first_name ?? "(unknown)";
	const username = message.from.username ?? "(unknown)";
	const isDM = (message.chat.type == "private");
	const msg = message.text.toLowerCase().split("@")[0]; // Remove stuff after the first @ symbol

	const secret = msg.includes(process.env.WHITELIST_PASS!);
	if(secret)
		bot.sendMessage(chatId, "Accepted!", {});

	if(!whitelist.hasOwnProperty(userId))
	{
		if(!isDM)
			return;
		else if(!secret)
		{
			bot.sendMessage(chatId, util.format("Who dis? (%d)", userId), {});
			sendGroupMessage(util.format("An unknown user is talking to the dog! %s - %s", username, message.text), {});
			return;
		}
		else
		{
			whitelist[userId] = {
				"name": name,
				"added": new Date()
			};

			// TODO this is async, should wait for callback before writing again
			writeFile("./whitelist.json", JSON.stringify(whitelist), (err) => {
				if(err) logger.error(err.message);
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
			]
		}
	};

	const commandActions: Record<DoorEntry.TelegramCommands, Function> = {
		"unlock": () => {
			// Send door unlock action to all connected notifiers
			doorUnlock(name)
	
			// Reply to message sender
			if(isDM)
				bot.sendMessage(chatId, "Unlocked for 3 seconds!", opts);
			
			// Send message to group
			//sendGroupMessage("\u{1F513} *" + message.from.first_name + " unlocked!*");
		},
		"autounlock": () => {
			if(isDM)
				bot.sendMessage(chatId, "Auto-unlock enabled for 5 minutes", opts);
			sendGroupMessage(util.format("Auto-unlock enabled by %s for 5 minutes", name), {});

			autoUnlockTimer.start();
		},
		"auto-unlock": () => {},
		"status": () => {
			svr.sendAll({action: "status"}, {chatId: chatId});
		}
	};
	commandActions["auto-unlock"] = commandActions.autounlock;

	const command = ((msg.charAt(0) == "/") ? msg.slice(1) : msg) as DoorEntry.TelegramCommands;
	(command in commandActions) ? commandActions[command]() : bot.sendMessage(chatId, "OwO", opts);
});

bot.on("sticker", (message) => {
	logger.info(message);
});

bot.on("polling_error", (error) => {
	logger.error(error)
});

bot.on("webhook_error", (error) => {
	logger.error(error)
});
