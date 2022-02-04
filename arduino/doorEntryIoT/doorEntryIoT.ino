/*
 * Project: Door Entry IoT
 * Author: Zak Kemble, contact@zakkemble.net
 * Copyright: (C) 2022 by Zak Kemble
 * License: 
 * Web: https://blog.zakkemble.net/iot-and-a-door-entry-system/
 */

#define ARDUINOJSON_USE_LONG_LONG 1
#include <ESP8266WiFi.h>
#include <WiFiClient.h>
#include <ESP8266WebServer.h>
#include <ESP8266HTTPUpdateServer.h>
#include <Ticker.h>
#include <Wire.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include "resources.h"

// Third party libraries:
// WebSocketsClient https://github.com/Links2004/arduinoWebSockets
// ArduinoJson https://arduinojson.org/

// IDE Settings:
// Board: Generic ESP8266 Module (or Generic ESP8285 Module)
// Builtin LED: 2
// CPU Freq: 80MHz
// Xtal freq: 26MHz
// Flash size: 1MB
// Flash mode; DOUT
// Flash freq: 40MHz

// Other links:
// https://github.com/gilmaimon/ArduinoWebsockets
// https://arduino-esp8266.readthedocs.io/en/latest/esp8266wifi/generic-class.html

#define FW_VERSION		"1.0.0 211117"
#define FW_BUILD		__DATE__ " " __TIME__

#define WEBSOCKET_HOST	"example.com"
#define WEBSOCKET_PORT	8080
#define WEBSOCKET_URI	"/"

#define WEBSERVER_PORT	80

#define AUTH_USER		"doorentry"
#define AUTH_PASS		"abc12345"

#define STA_SSID		F("MyWiFi123")
#define STA_PASS		F("password69")

#define PIN_LED			LED_BUILTIN
#define PIN_DOORLOCK	14

#define LINE_IDLE		0
#define LINE_UNLOCKED	1
#define LINE_RING		2

#define SESSION_WAITING	0
#define SESSION_OK		1

#define SHT3X_ADDR		0x44

typedef uint32_t millis_t;

static WiFiEventHandler staConnectedHandler;
static WiFiEventHandler staDisconnectedHandler;
static WiFiEventHandler staGotIPHandler;
static WiFiEventHandler staDHCPTimeoutHandler;
static WebSocketsClient webSocket;
static ESP8266WebServer server(WEBSERVER_PORT);
static ESP8266HTTPUpdateServer httpUpdater; // https://github.com/esp8266/Arduino/blob/master/libraries/ESP8266HTTPUpdateServer/examples/WebUpdater/WebUpdater.ino

typedef struct {
	uint32_t wifi;
	uint32_t ws;
	uint32_t ring;
	uint32_t unlock;
	uint32_t neighbourUnlock;
	uint32_t stuck;
	uint32_t rollover;
} counts_t;

static counts_t counts;
static String sessionId;
static uint8_t sessionState;
static uint8_t lineState;
static float temperature;
static float humidity;
static WiFiDisconnectReason lastDisconnectReason;

static String macToString(const unsigned char* mac)
{
	char buf[20];
	snprintf(buf, sizeof(buf), "%02x:%02x:%02x:%02x:%02x:%02x",
		mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
	return String(buf);
}

static unsigned long long millis64()
{
	return millis() + ((uint64_t)counts.rollover<<32);
}

static void doorUnlock(millis_t duration)
{
	static Ticker doorUnlockTmr;

	if(duration == 0)
	{
		doorUnlockTmr.detach();
		digitalWrite(PIN_DOORLOCK, 0);
//		doorLockedTime = millis();
	}
	else
	{
		//if(duration < 500)
		//	duration = 500;
		//else if(duration > 15000)
		//	duration = 15000;

		if(duration > 15000)
			duration = 15000;

		counts.unlock++;

		digitalWrite(PIN_DOORLOCK, 1);
		doorUnlockTmr.once_ms_scheduled(duration, []() {
			digitalWrite(PIN_DOORLOCK, 0);
//			doorLockedTime = millis();
		});
	}
}

static void ledFlash()
{
	static Ticker ledFlash;

	digitalWrite(PIN_LED, 0);
	ledFlash.once_ms_scheduled(10, []() {
		digitalWrite(PIN_LED, 1);
	});
}

static void fillJSON(JsonDocument& doc)
{
	doc["millis"] = millis64();
	doc["session"] = sessionId;
	doc["disconnectreason"] = lastDisconnectReason;

	doc["fw"]["version"] = FW_VERSION;
	doc["fw"]["build"] = FW_BUILD;

	doc["counts"]["wifi"] = counts.wifi;
	doc["counts"]["ws"] = counts.ws;
	doc["counts"]["ring"] = counts.ring;
	doc["counts"]["unlock"] = counts.unlock;
	doc["counts"]["neighbour"] = counts.neighbourUnlock;
	doc["counts"]["stuck"] = counts.stuck;
	
	doc["net"]["ip"] = WiFi.localIP().toString();
	doc["net"]["subnet"] = WiFi.subnetMask().toString();
	doc["net"]["gateway"] = WiFi.gatewayIP().toString();
	doc["net"]["dns1"] = WiFi.dnsIP(0).toString();
	doc["net"]["dns2"] = WiFi.dnsIP(1).toString();
	doc["net"]["hostname"] = WiFi.hostname();
	
	doc["wifi"]["ssid"] = WiFi.SSID();
	doc["wifi"]["bssid"] = WiFi.BSSIDstr();
	doc["wifi"]["channel"] = WiFi.channel();
	doc["wifi"]["mac"] = WiFi.macAddress();
	doc["wifi"]["rssi"] = WiFi.RSSI();
	
	doc["env"]["t"] = temperature;
	doc["env"]["h"] = humidity;
}

static void sendNotification(String notification, String requestId = "")
{
	if(notification != "connected" && sessionState != SESSION_OK)
	{
		Serial.println(F("Attempted to send notification without session ID"));
		return;
	}

	StaticJsonDocument<1024> doc;
	doc["notify"] = notification;
	doc["requestId"] = requestId;
	fillJSON(doc);
	String msg;
	serializeJson(doc, msg);
	webSocket.sendTXT(msg);
}

static void webHandleRoot()
{
	uint64_t uptime = millis64();
	uint32_t mins = uptime / 1000 / 60;
	uint32_t hours = mins / 60;
	uint32_t days = hours / 24;
	hours %= 24;
	mins %= 60;

	const int len = sizeof(html_home) + 512;

	//char buf[len];
	char* buf = (char*)malloc(len);

	int ret = snprintf_P(buf, len, html_home,
		days,
		hours,
		mins,
		uptime,
		sessionId.c_str(),
		counts.wifi,
		lastDisconnectReason,
		counts.ws,
		counts.ring,
		counts.unlock,
		counts.neighbourUnlock,
		counts.stuck,
		WiFi.localIP().toString().c_str(),
		WiFi.subnetMask().toString().c_str(),
		WiFi.gatewayIP().toString().c_str(),
		WiFi.dnsIP(0).toString().c_str(),
		WiFi.dnsIP(1).toString().c_str(),
		WiFi.hostname().c_str(),
		WiFi.macAddress().c_str(),
		WiFi.SSID().c_str(),
		WiFi.BSSIDstr().c_str(),
		WiFi.channel(),
		WiFi.RSSI(),
		temperature,
		humidity,
		FW_VERSION,
		FW_BUILD
	);

	if(ret >= len)
		strcpy(buf, "Buffer overflow");

	server.send(200, F("text/html"), buf);
	ledFlash();
	
	free(buf);
}

static void webHandleUnlock()
{
	uint32_t duration = 0;

	for(uint8_t i=0;i<server.args();i++)
	{
		if(server.argName(i) == F("duration"))
		{
			duration = server.arg(i).toInt();
			break;
		}
	}

	doorUnlock(duration);

	server.send(200, F("text/plain"), F("ok"));
	ledFlash();
}

static void webHandleNotFound()
{
	String message = F("404 File Not Found\n\n");
	message += F("URI: ");
	message += server.uri();
	message += F("\nMethod: ");
	message += (server.method() == HTTP_GET) ? F("GET") : F("POST");
	message += F("\nArguments: ");
	message += server.args();
	message += F("\n");
	for(uint8_t i=0;i<server.args();i++)
		message += " " + server.argName(i) + ": " + server.arg(i) + "\n";
	server.send(404, F("text/plain"), message);
	ledFlash();
}

static void webSocketEvent(WStype_t type, uint8_t* payload, size_t length)
{
	switch(type)
	{
		case WStype_DISCONNECTED:
			Serial.println(F("[WSc] Disconnected"));
			webSocket.setReconnectInterval(5000);
			ledFlash();
			break;
		case WStype_CONNECTED:
		{
			sessionState = SESSION_WAITING;
			counts.ws++;
			Serial.println(F("[WSc] Connected"));
			ledFlash();
			sendNotification("connected");
		}
			break;
		case WStype_TEXT:
		{
			Serial.print(F("[WSc] Text: "));
			Serial.println((char*)payload);

			StaticJsonDocument<256> doc;
			DeserializationError error = deserializeJson(doc, payload);

			if(error)
			{
				Serial.print(F("deserializeJson() failed: "));
				Serial.println(error.f_str());
				//sendNotification("error", doc["requestId"]); // TODO
			}
			else
			{
				String action = doc["action"];
				if(action == "unlock")
				{
					doorUnlock(doc["duration"]);
					sendNotification("unlocked", doc["requestId"]);
				}
				else if(action == "status")
					sendNotification("status", doc["requestId"]);
				else if(action == "session")
				{
					sessionId = doc["session"].as<String>();
					sessionState = SESSION_OK;
					Serial.print(F("New session ID: "));
					Serial.println(sessionId);
				}
				else
				{
					Serial.print(F("Unknown action: "));
					Serial.println(action);
				}
			}

			ledFlash();
		}
		break;
		case WStype_BIN:
			Serial.print(F("[WSc] Binary: "));
			Serial.println(length);
			hexdump(payload, length);
			ledFlash();
			break;
		case WStype_PING:
			Serial.println(F("[WSc] Ping"));
			ledFlash();
			break;
		case WStype_PONG:
			Serial.println(F("[WSc] Pong"));
			ledFlash();
			break;
		case WStype_ERROR:
			Serial.println(F("[WSc] ERROR"));
			break;
		default:
			Serial.println(F("[WSc] DEFAULT"));
			break;
	}
}

static void onStaConnected(const WiFiEventStationModeConnected& evt)
{
	Serial.print(F("Connected: "));
	Serial.print(evt.ssid);
	Serial.print(F(" "));
	Serial.print(macToString(evt.bssid));
	Serial.print(F(" "));
	Serial.println(evt.channel);
	
	ledFlash();
	
	counts.wifi++;
}

static void onStaDisconnected(const WiFiEventStationModeDisconnected& evt)
{
	Serial.print(F("Disconnected: "));
	Serial.print(evt.ssid);
	Serial.print(F(" "));
	Serial.print(macToString(evt.bssid));
	Serial.print(F(" "));
	Serial.println(evt.reason);
	
	lastDisconnectReason = evt.reason;
	
	ledFlash();
}

static void onStaGotIP(const WiFiEventStationModeGotIP& evt)
{
	Serial.print(F("Got IP: "));
	Serial.print(evt.ip);
	Serial.print(F(" "));
	Serial.print(evt.mask);
	Serial.print(F(" "));
	Serial.println(evt.gw);

	static bool webSocketStarted;
	if(!webSocketStarted)
	{
		webSocketStarted = true;

		// Websocket client
		webSocket.begin(WEBSOCKET_HOST, WEBSOCKET_PORT, WEBSOCKET_URI);
		webSocket.onEvent(webSocketEvent);
		webSocket.setAuthorization(AUTH_USER, AUTH_PASS);
		webSocket.setReconnectInterval(50); // Set a small reconnect interval so the first connection attempt happens sooner, then set to a more sain value in WStype_DISCONNECTED event
		webSocket.enableHeartbeat(15000, 3000, 5);
	}
	
	ledFlash();
}

static void onStaDHCPTimeout()
{
	Serial.println(F("DHCP Timeout"));
	ledFlash();
}

static void sht3x_startConversion()
{
	Wire.beginTransmission(SHT3X_ADDR);
	Wire.write(0x24);
	Wire.write(0x00);
	uint8_t res = Wire.endTransmission();
	if(res != 0)
	{
		Serial.print(F("SHT3X I2C Error: "));
		Serial.println(res);
	}
}

static bool sht3x_getData()
{
	if(Wire.requestFrom(SHT3X_ADDR, 6) == 0)
	{
		//Serial.println(F("BUSY"));
		return false;
	}

	uint8_t data[3];

	// Temperature is a linear scale of 0x0000 (-45C) to 0xFFFF (+130C)
	Wire.readBytes(data, (uint8_t)3);
	// checksum in data[2]
	data[2] = data[0];
	data[0] = data[1];
	data[1] = data[2];
	temperature = (175 * (*(uint16_t*)data / (float)0xFFFF)) - 45;

	// Humidity is a linear scale of 0x0000 (0%) to 0xFFFF (100%)
	Wire.readBytes(data, (uint8_t)3);
	// checksum in data[2]
	data[2] = data[0];
	data[0] = data[1];
	data[1] = data[2];
	humidity = 100 * (*(uint16_t*)data / (float)0xFFFF);
	
	return true;
}

static void tempHumidity()
{
	static millis_t lastTempHum;
	static uint8_t state;

	if(state == 0 && (millis() - lastTempHum) > 10000)
	{
		// Do a conversion every 10 seconds
		lastTempHum = millis();
		state = 1;
		sht3x_startConversion();
	}
	else if(state == 1 && (millis() - lastTempHum) > 20)
	{
		// See if conversion has finished every 20ms
		lastTempHum = millis();
		if(sht3x_getData())
		{
			state = 0;
			Serial.print(": T=");
			Serial.print(temperature);
			Serial.print("C, RH=");
			Serial.print(humidity);
			Serial.println("%");
		}
	}
}

void setup()
{
	pinMode(PIN_DOORLOCK, OUTPUT);
	pinMode(PIN_LED, OUTPUT);
	digitalWrite(PIN_LED, 1);

	Serial.begin(115200);

	Serial.println();
	Serial.println(F("START"));

	Wire.begin();

	WiFi.mode(WIFI_STA);
	WiFi.begin(STA_SSID, STA_PASS);
	
	// WiFi Events
	staConnectedHandler = WiFi.onStationModeConnected(&onStaConnected);
	staDisconnectedHandler = WiFi.onStationModeDisconnected(&onStaDisconnected);
	staGotIPHandler = WiFi.onStationModeGotIP(&onStaGotIP);
	staDHCPTimeoutHandler = WiFi.onStationModeDHCPTimeout(&onStaDHCPTimeout);

	// HTTP Server
	server.onNotFound(webHandleNotFound);
	server.on(F("/"), webHandleRoot);
	server.on(F("/favicon.ico"), []() {
		server.send(200, (PGM_P)F("image/x-icon"), (PGM_P)FPSTR(favicon), sizeof(favicon));
		ledFlash();
	});
	server.on(F("/unlock"), webHandleUnlock);
	httpUpdater.setup(&server);
	server.begin();

	// ADC sample every 50ms
	static Ticker adcLineTmr;
	adcLineTmr.attach_ms_scheduled(50, []() {
		uint32_t adc = analogRead(A0);
		if(adc > 50)
			lineState = LINE_RING;
		else if(adc > 20)
			lineState = LINE_IDLE;
		else
			lineState = LINE_UNLOCKED;
	});
}

void loop()
{
	// This delay(1) is needed so that the module can go into low-power mode
	// No delay(), delay(0) and yield() don't work and they also give weird ping times
	delay(1);

	server.handleClient();
	webSocket.loop(); // WARNING: TCP Connect is blocking
	
	millis_t now = millis();

	// Millis() 32-bit rollover counter for
	// keeping track of uptime since we'll be
	// running for more than 50 days
	static millis_t lastMillis;
	if(lastMillis > now)
		counts.rollover++;
	lastMillis = now;


	tempHumidity();

	static millis_t bellRingTime;
	static millis_t doorUnlockTime;
	static uint8_t lastLineState;
	static bool stuck;

	if(lineState != lastLineState)
	{
		ledFlash();

		if(lineState == LINE_RING && (now - bellRingTime) > 2000)
		{
			bellRingTime = now;
			counts.ring++;
			Serial.println(F("Bell ringing"));
			sendNotification("ring");
		}
		else if(lineState == LINE_UNLOCKED && (now - doorUnlockTime) > 2000)
		{
			doorUnlockTime = now;
			if(digitalRead(PIN_DOORLOCK) == 0)
			{
				counts.neighbourUnlock++;
				Serial.println(F("Neighbor unlocked door"));
				sendNotification("neighbor");
			}
		}
		else if(lineState == LINE_IDLE)
		{
			Serial.println(F("Line idle"));
		}
		
		if(stuck)
		{
			stuck = false;
			Serial.println(F("Unstuck"));
			sendNotification("unstuck");
		}

		lastLineState = lineState;
	}
	else
	{
		if(!stuck && lineState == LINE_UNLOCKED && (now - doorUnlockTime) > 10000)
		{
			counts.stuck++;
			stuck = true;
			Serial.println(F("Stuck"));
			sendNotification("stuck");
		}
	}
}
