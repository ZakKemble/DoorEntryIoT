/*
 * Project: Door Entry System IoT
 * Author: Zak Kemble, contact@zakkemble.net
 * Copyright: (C) 2022 by Zak Kemble
 * License: 
 * Web: https://blog.zakkemble.net/iot-and-a-door-entry-system/
 */

import http from "node:http";
import util from "node:util";
import EventEmitter from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { v4 as uuidV4, validate as uuidValidate } from "uuid";
import logger from "./logger";

export namespace DoorEntry
{
	const NotificationsAll = ["connected", "ring", "unlocked", "neighbor", "status", "stuck", "unstuck"] as const;
	export type Notifications = typeof NotificationsAll[number];

	type Actions = "session" | "unlock" | "status";
	export type TelegramCommands = "unlock" | "autounlock" | "auto-unlock" | "status";

	export interface IMessage {
		session: string,
		notify: Notifications,
		requestId: string,
		millis: number,
		counts: any,
		net: any,
		wifi: any,
		env: any
	}

	export interface IAction {
		action: Actions,
		session?: string,
		duration?: number,
		serverId?: string,
		requestId?: string
	}

	interface WhitelistEntry {
		name: string,
		added: Date
	}
	export type Whitelist = Record<string, WhitelistEntry>;

	export class Session
	{
		id: string;
		created: Date;
		lastseen: Date;
		requests: Map<string, Request>;

		constructor()
		{
			this.id = uuidV4();
			this.created = new Date();
			this.lastseen = new Date();
			this.requests = new Map();
		}

		match(id: string)
		{
			return (this.id === id);
		}

		seen()
		{
			this.lastseen = new Date();
		}

		makeRequest(data: any)
		{
			const req = new Request(data);
			this.requests.set(req.id, req);
			return req;
		}

		getRequest(id: string)
		{
			const request = this.requests.get(id);
			this.requests.delete(id);
			return request;
		}
	}

	class SessionManager extends EventEmitter
	{
		sessions: Map<string, Session> = new Map();
		timeoutInterval = setInterval(() => {
			this.cleanup();
		}, 60000);
	
		cleanup()
		{
			const now = Date.now();
	
			this.sessions.forEach((sess, key) => {
				if((now - sess.lastseen.getTime()) > 600000) // 10 min
				{
					this.emit("timeout", sess);
					this.sessions.delete(key);
				}
				else
				{
					// Clear data for old requests that were never replied to
					sess.requests.forEach((req, key2) => {
						if((now - req.time.getTime()) > 60000) // 1 min
							sess.requests.delete(key2);
					});
				}
			});
		}
		
		find(id: string)
		{
			return this.sessions.get(id);
		}
	
		make()
		{
			const sess = new Session();
			this.sessions.set(sess.id, sess);
			return sess;
		}
	}

	export class Request
	{
		id: string;
		time: Date;
		data: any;

		constructor(data: any)
		{
			this.id = uuidV4();
			this.time = new Date();
			this.data = data;
		}
	}

	export class Device extends WebSocket
	{
		ip: string | string[] | undefined = "";
		clientId: number = 0;
		serverId: string = "";
		isAlive: boolean = true;
		session: Session | null = null;
	
		alive()
		{
			this.isAlive = true;
		}

		onMessage(msg: DoorEntry.IMessage, request: Request | undefined)
		{
			this.emit(NotificationsAll.includes(msg.notify) ? msg.notify : "unknown", msg, request);
		}

		unlock(duration: number, serverData: any)
		{
			const request = this.session?.makeRequest(serverData);
			if(request)
			{
				this.send({
					action: "unlock",
					duration: duration,
					requestId: request.id
				});
			}
		}
	
		send(data: IAction)
		{
			data.serverId = this.serverId;
			super.send(JSON.stringify(data));
		}
	}

	export class Server extends WebSocketServer
	{
		sessionManager: SessionManager = new SessionManager();
		clientId: number = 0;
		serverId: string;
		aliveInterval = setInterval(() => {
			this.keepAlive();
		}, 60000);

		constructor(port: number, user: string, pass: string)
		{
			super({
				noServer: true,
				maxPayload: 1024,
				WebSocket: Device
			});

			this.sessionManager.on("timeout", (sess) => {
				this.emit("timeout", sess);
			});

			this.serverId = uuidV4();
			const auth = "Basic " + Buffer.from(user + ":" + pass).toString("base64");

			const server = http.createServer((request, response) => {
				logger.info("Request from %s for %s", request.socket.remoteAddress, request.url);
				response.writeHead(404).end("404 Not Found");
			});
			
			server.on("upgrade", (request, socket, head) => {
		
				logger.info("%s Upgrade request", request.socket.remoteAddress);

				if(request.headers.authorization == auth)
				{
					logger.info("%s Upgrade accepted", request.socket.remoteAddress);
		
					this.handleUpgrade(request, socket, head, (ws) => {
						this.emit("connection", ws, request);
					});
				}
				else
				{
					logger.info("%s Upgrade denied", request.socket.remoteAddress);
					socket.write(util.format("HTTP/%s 401 Unauthorized\r\n\r\n401 Unauthorized", request.httpVersion));
					socket.destroy();
				}
			});
			
			server.listen(port, () => {
				logger.info("Server is listening on port " + port);
				this.emit("start", server);
			});

			this.on("connection", (ws, request) => {

				const doorEntry = ws as Device;

				doorEntry.ip = request.headers.hasOwnProperty("x-real-ip") ? request.headers["x-real-ip"] : request.socket.remoteAddress;
				doorEntry.clientId = this.clientId;
				doorEntry.serverId = this.serverId;
				this.clientId++;

				logger.info("%s Connection accepted, client ID: %d", doorEntry.ip, doorEntry.clientId);

				doorEntry.on("message", (data) => {

					const str = data.toString();
					logger.info("%d Received message: %s", doorEntry.clientId, str);

					let message: DoorEntry.IMessage;
					try { message = JSON.parse(str); }
					catch (err) { doorEntry.emit("error", err); return; }

					logger.info(message);

					// TODO validate message properties

					if(message.notify == "connected")
					{
						const isNewConnection = (doorEntry.session == null);

						if(isNewConnection)
							doorEntry.session = this.sessionManager.find(message.session) ?? this.sessionManager.make();

						doorEntry.send({
							action: "session",
							session: doorEntry.session!.id // TODO better way to write this so we don't need the "!" ?
						});

						this.emit("device", doorEntry, isNewConnection);
					}
					else if(doorEntry.session?.match(message.session))
					{
						doorEntry.session.seen();
						const requestData = doorEntry.session.getRequest(message.requestId);
						doorEntry.onMessage(message, requestData);
					}
					else
					{
						// session mismatch, must reconnect  // TODO

						// no session data, must send "connected" notify  // TODO
						const msg = util.format("Notify '%s' with bad session data", message.notify);
						doorEntry.emit("error", new Error(msg));
					}

				});

				doorEntry.on("close", (code, reason) => {
					logger.info("%d Disconnected (%d) (%s)", doorEntry.clientId, code, reason);
				});

				doorEntry.on("ping", (data) => {
					//consoleLog('%d Pinged', ws.clientId);
					doorEntry.alive();
				});

				doorEntry.on("error", (err) => {
					logger.error(err)
				});
			});
		}

		keepAlive()
		{
			this.clients.forEach((ws) => {
				const doorEntry = ws as Device;
				if (!doorEntry.isAlive)
				{
					logger.info("Heartbeat lost, terminating... %s %d", doorEntry.ip, doorEntry.clientId);
					doorEntry.terminate();
				}
				doorEntry.isAlive = false;
			});
		}

		sendAll(clientData: IAction, serverData: any)
		{
			this.clients.forEach((ws) => {
				const doorEntry = ws as Device;
				const request = doorEntry.session?.makeRequest(serverData);
				if(request)
				{
					clientData.requestId = request.id;
					doorEntry.send(clientData);
				}
			});
		}
	}
}
