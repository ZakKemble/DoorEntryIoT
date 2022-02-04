/*
 * Project: Door Entry IoT
 * Author: Zak Kemble, contact@zakkemble.net
 * Copyright: (C) 2022 by Zak Kemble
 * License: 
 * Web: https://blog.zakkemble.net/iot-and-a-door-entry-system/
 */

const config = {};

config.TG_TOKEN = "123456789:AAAAggggeeeGGeeeGGHHHHHH"; // Bot token
config.TG_CHATID = "123456789"; // Group chat ID

config.AUTH_USER = "doorentry";
config.AUTH_PASS = "abc12345";

config.HTTP_PORT = 8080;

config.WHITELIST_PASS = "henlo";

config.UNLOCK_DURATION = 3000;
config.AUTOUNLOCK_TIME = 300000;

module.exports = config;
