/*
 * Project: Door Entry IoT
 * Author: Zak Kemble, contact@zakkemble.net
 * Copyright: (C) 2022 by Zak Kemble
 * License: 
 * Web: https://blog.zakkemble.net/iot-and-a-door-entry-system/
 */

// Deals with logging and HTTP/websocket server


const http = require("http");
const WebSocket = require("ws");
const util = require("util");
const uuid = require("uuid");

var clientId = 0;
var sessions = {};

var onSession = null;
var onSessionEnd = null
var onMessage = null;
var onClose = null;
var onError = null;

var serverId = "";

const wss = new WebSocket.Server({
	noServer: true,
	maxPayload: 1024
});

const aliveInterval = setInterval(function(){
	wss.clients.forEach(function(ws) {
		if (ws.isAlive === false)
		{
			consoleLog("Heartbeat lost, terminating... %s %d", ws.ip, ws.clientId);
			ws.terminate();
		}
		else
			ws.isAlive = false;
	});

	Object.keys(sessions).forEach(function(key, index){
		if(Date.now() - sessions[key].lastseen > 600000) // 10 min
		{
			if(onSessionEnd !== null)
				onSessionEnd(sessions[key]);
			delete sessions[key];
		}
		else
		{
			// Clear data for old requests that were never replied to
			Object.keys(sessions[key].requests).forEach(function(key2, index2){
				if(Date.now() - sessions[key].requests[key2].time > 60000) // 1 min
					delete sessions[key].requests[key2];
			});
		}
	});
}, 60000);

function formatFullDateTime()
{
	var d = new Date();
	var dateStr = util.format(
		"%d-%s-%s %s:%s:%s",
		d.getFullYear(),
		String(d.getMonth()+1).padStart(2, "0"),
		String(d.getDate()).padStart(2, "0"),
		String(d.getHours()).padStart(2, "0"),
		String(d.getMinutes()).padStart(2, "0"),
		String(d.getSeconds()).padStart(2, "0")
	);
	return dateStr;
}

function consoleLog(obj, ...args)
{
	const dateStr = formatFullDateTime();

	if(typeof(obj) == "object")
	{
		console.log("[%s] [OBJECT]:", dateStr);
		console.log(obj);
	}
	else
		console.log(util.format("[%s] %s", dateStr, obj), ...args);
}

function consoleError(obj, ...args)
{
	const dateStr = formatFullDateTime();

	if(typeof(obj) == "object")
	{
		console.error("[%s] [OBJECT]:", dateStr);
		console.error(obj);
	}
	else
		console.error(util.format("[%s] %s", dateStr, obj), ...args);
}

function start(config)
{
	onSession = config.onSession;
	onSessionEnd = config.onSessionEnd;
	onMessage = config.onMessage;
	onClose = config.onClose;
	onError = config.onError;
	
	serverId = uuid.v4();

	const authinfo = {
		user: config.auth.user,
		pass: config.auth.pass
	};

	function authenticate(request, callback)
	{
		consoleLog(request.headers);
		var auth = Buffer.from(authinfo.user + ":" + authinfo.pass).toString("base64");
		callback(request.headers.authorization === ("Basic " + auth));
	}

	const server = http.createServer(function(request, response){
		consoleLog("Request from %s for %s", request.connection.remoteAddress, request.url);
		response.writeHead(404);
		response.end("404");
	});

	server.on("upgrade", function upgrade(request, socket, head) {

		consoleLog("%s Upgrade request", request.socket.remoteAddress);

		authenticate(request, (valid) => {
			if (!valid)
			{
				consoleLog("%s Upgrade denied", request.socket.remoteAddress);
				socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n401 Unauthorized");
				socket.destroy();
				return;
			}

			consoleLog("%s Upgrade accepted", request.socket.remoteAddress);

			wss.handleUpgrade(request, socket, head, function done(ws) {
				wss.emit("connection", ws, request);
			});
		});

	});

	server.listen(config.http_port, function() {
		consoleLog("Server is listening on port " + config.http_port);
		if(config.onStart !== null)
			config.onStart();
	});
}

function makeSession()
{
	const sessionId = uuid.v4();
	sessions[sessionId] = {
		id: sessionId,
		created: Date.now(),
		lastseen: Date.now(),
		requests: {}
	};
	return sessions[sessionId];
}

function getSession(sessionId)
{
	if(uuid.validate(sessionId) && sessions.hasOwnProperty(sessionId))
		return sessions[sessionId];
	return null;
}

function makeRequest(session)
{
	const requestId = uuid.v4();
	session.requests[requestId] = {
		id: requestId,
		time: Date.now(),
		data: null
	};
	return session.requests[requestId];
}

function getRequest(session, requestId)
{
	var request = null;
	if(uuid.validate(requestId) && session.requests.hasOwnProperty(requestId))
	{
		request = session.requests[requestId];
		delete session.requests[requestId];
	}
	return request;
}

function sendAll(object, requestObject)
{
	wss.clients.forEach(function each(ws) {
		if(ws.session === null)
			return;

		const request = makeRequest(ws.session);
		request.data = requestObject;
		
		object.requestId = request.id;

		send(ws, object);
	});
}

function send(ws, object)
{
	object.serverId = serverId;
	const json = JSON.stringify(object);
	ws.send(json);
}

// WebSocket
// This part receives messages from intercom notifiers and tells the TG bot to send messages to the group chat
wss.on("connection", function connection(ws, request) {

	ws.ip = request.headers.hasOwnProperty("x-real-ip") ? request.headers["x-real-ip"] : request.socket.remoteAddress;
	ws.isAlive = true;
	ws.clientId = clientId;
	ws.session = null;
	clientId++;

	consoleLog("%s Connection accepted, client ID: %d", ws.ip, ws.clientId);

	ws.on("message", function message(msg) {
		consoleLog("%d Received message: %s", ws.clientId, msg);

		var object = null;
		try
		{
			object = JSON.parse(msg);
			consoleLog(object);
		}
		catch (err)
		{
			consoleLog(err);
			if(onError !== null)
				onError(util.format("JSON Error: %s", err));
		}
		
		if(object !== null) // JSON is valid
		{
			if(object.notify === "connected")
			{
				if(ws.session === null)
				{
					var isNew = false;
					ws.session = getSession(object.session);
					if(ws.session === null) // Session not found, make new session (new connection)
					{
						isNew = true;
						ws.session = makeSession();
					}

					send(ws, {
						action: "session",
						session: ws.session.id
					});

					if(onSession !== null)
						onSession(ws, object, isNew);
				}
				else
				{
					// unexpected "connected" notified again  // TODO
					ws.session.lastseen = Date.now();
				}
			}
			else
			{
				if(ws.session !== null)
				{
					if(ws.session.id === object.session)
					{
						ws.session.lastseen = Date.now();
						var requestData = getRequest(ws.session, object.requestId);
						if(onMessage !== null)
							onMessage(ws, object, requestData);
					}
					else
					{
						// session mismatch, must reconnect  // TODO
					}
				}
				else
				{
					// no session data, must send "connected" notify  // TODO
					consoleLog("Notify '%s' with no session data", object.notify);
					if(onError !== null)
						onError(util.format("Notify '%s' with no session data", object.notify));
				}
			}
		}
	});

	ws.on("close", function close(code, reason) {
		consoleLog("%d Disconnected (%d) (%s)", ws.clientId, code, reason);
		if(onClose !== null)
			onClose(ws, code, reason);
	});

	ws.on("ping", function ping(data) {
		//consoleLog('%d Pinged', ws.clientId);
		ws.isAlive = true;
		if(ws.session !== null)
			ws.session.lastseen = Date.now();
	});
});

module.exports = {
	formatFullDateTime,
	consoleLog,
	consoleError,
	start,
	sendAll
};
