/*
 * Project: Door Entry System IoT
 * Author: Zak Kemble, contact@zakkemble.net
 * Copyright: (C) 2022 by Zak Kemble
 * License: 
 * Web: https://blog.zakkemble.net/iot-and-a-door-entry-system/
 */

import util from "node:util";

function formatFullDateTime()
{
	const d = new Date();
	const dateStr = util.format(
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

function info(obj: any, ...args: any)
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

function error(obj: any, ...args: any)
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

export default {
	formatFullDateTime,
	info,
	error
};
