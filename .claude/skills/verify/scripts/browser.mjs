#!/usr/bin/env node
// browser.mjs <run dir> <name> <step>...: drive the interface in headless
// system Chrome over CDP, with a screenshot after every step.
// Steps (each is one word followed by its arguments):
//   goto <hash>                 open a route, as in goto '#/org'
//   click <selector>            click an element, as a user does
//   fill <selector> <text>      focus a field, clear it, type the text
//   choose <selector> <value>   pick an option of a <select>
//   wait <selector>             wait for an element to exist
//   gone <selector>             wait for an element to stop existing
//   count <selector> <n>        wait for exactly n matching elements
//   text <selector> <text>      wait for an element whose text contains it
//   mark                        set a window marker before an action
//   same-page                   assert the marker survived (no reload)
//   outside <verb> <json>       run an action from outside the page, as
//                               another client of the Action endpoint
//   save <selector> <file>      save the element's text under the proof dir
// Writes <run>/proof/<name>/NN-<step>.png and steps.tsv. Exits 1 at the
// first step that fails, after a screenshot of the failure.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const [runArg, name, ...rest] = process.argv.slice(2);
if (!runArg || !name || rest.length === 0) {
	console.error("usage: browser.mjs <run dir> <name> <step>...");
	process.exit(2);
}
const run = resolve(runArg);
if (!existsSync(join(run, "run.env"))) {
	console.error(`verify: ${run} has no run.env: launch.sh did not create it`);
	process.exit(1);
}
const env = Object.fromEntries(
	readFileSync(join(run, "run.env"), "utf8")
		.split("\n")
		.map((line) => line.match(/^(\w+)='?(.*?)'?$/))
		.filter(Boolean)
		.map((m) => [m[1], m[2]]),
);
const base = env.URL;
const out = join(run, "proof", name);
mkdirSync(out, { recursive: true });
const tsv = join(out, "steps.tsv");
writeFileSync(tsv, "n\tstep\tresult\tscreenshot\n");

const ARITY = { goto: 1, click: 1, fill: 2, choose: 2, wait: 1, gone: 1, count: 2, text: 2, mark: 0, "same-page": 0, outside: 2, save: 2 };
const steps = [];
for (let i = 0; i < rest.length; ) {
	const verb = rest[i];
	const arity = ARITY[verb];
	if (arity === undefined) {
		console.error(`unknown step ${verb}; steps are ${Object.keys(ARITY).join(", ")}`);
		process.exit(2);
	}
	steps.push([verb, ...rest.slice(i + 1, i + 1 + arity)]);
	i += 1 + arity;
}

const chromePath =
	process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = join(run, `chrome-profile-${name.replace(/\W+/g, "-")}-${process.pid}`);
const chrome = spawn(
	chromePath,
	[
		"--headless=new",
		"--remote-debugging-port=0",
		`--user-data-dir=${profile}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--window-size=1280,900",
		"about:blank",
	],
	{ stdio: "ignore" },
);
appendFileSync(join(run, "chrome.pids"), `${chrome.pid}\n`);

const until = async (what, probe, ms = 10000) => {
	const end = Date.now() + ms;
	for (;;) {
		const value = await probe();
		if (value) return value;
		if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
		await sleep(100);
	}
};

let ws;
let nextId = 1;
const pending = new Map();
const send = (method, params = {}) =>
	new Promise((ok, fail) => {
		const id = nextId++;
		pending.set(id, { ok, fail, method });
		ws.send(JSON.stringify({ id, method, params }));
	});

const evaluate = async (expression) => {
	const { result, exceptionDetails } = await send("Runtime.evaluate", {
		expression,
		awaitPromise: true,
		returnByValue: true,
	});
	if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
	return result.value;
};

const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
const need = async (selector) => {
	if (!(await evaluate(`${q(selector)} !== null`))) throw new Error(`no element matches ${selector}`);
};

let shots = 0;
const shot = async (label) => {
	const n = String(++shots).padStart(2, "0");
	const file = `${n}-${label.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)}.png`;
	const { cssContentSize: size } = await send("Page.getLayoutMetrics");
	const { data } = await send("Page.captureScreenshot", {
		format: "png",
		captureBeyondViewport: true,
		clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
	});
	writeFileSync(join(out, file), Buffer.from(data, "base64"));
	return file;
};

const act = {
	goto: async (hash) => {
		await send("Page.navigate", { url: `${base}/${hash}` });
		await until("the view to draw", () => evaluate(`document.querySelector("main")?.children.length > 0`));
	},
	click: async (selector) => {
		await need(selector);
		await evaluate(`${q(selector)}.click()`);
	},
	fill: async (selector, text) => {
		await need(selector);
		await evaluate(`(() => { const f = ${q(selector)}; f.focus(); f.value = ""; })()`);
		await send("Input.insertText", { text });
	},
	choose: async (selector, value) => {
		await need(selector);
		await evaluate(
			`(() => { const f = ${q(selector)}; f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event("change", { bubbles: true })); return f.value; })()`,
		);
	},
	wait: (selector) => until(selector, () => evaluate(`${q(selector)} !== null`)),
	gone: (selector) => until(`${selector} to go`, () => evaluate(`${q(selector)} === null`)),
	count: (selector, n) =>
		until(`exactly ${n} of ${selector}`, () =>
			evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length === ${Number(n)}`),
		),
	text: (selector, text) =>
		until(`${selector} to contain "${text}"`, () =>
			evaluate(
				`[...document.querySelectorAll(${JSON.stringify(selector)})].some((e) => e.textContent.includes(${JSON.stringify(text)}))`,
			),
		),
	mark: () => evaluate(`window.__verifyMark = ${Date.now()}`),
	"same-page": async () => {
		if (!(await evaluate(`window.__verifyMark !== undefined`))) throw new Error("the page reloaded: the marker is gone");
	},
	outside: async (verb, json) => {
		const res = await fetch(`${base}/api/actions/${verb}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: json,
		});
		const body = await res.text();
		writeFileSync(join(out, `outside-${verb}.json`), body);
		if (!res.ok) throw new Error(`POST /api/actions/${verb} answered ${res.status}: ${body}`);
		return `${res.status} ${body.slice(0, 120)}`;
	},
	save: async (selector, file) => {
		await need(selector);
		writeFileSync(join(out, file), await evaluate(`${q(selector)}.innerText`));
		return file;
	},
};

let status = 0;
try {
	const port = await until(
		"Chrome's DevToolsActivePort",
		() => existsSync(join(profile, "DevToolsActivePort")) && readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0],
		20000,
	);
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	const page = targets.find((t) => t.type === "page");
	ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((ok, fail) => {
		ws.onopen = ok;
		ws.onerror = fail;
	});
	ws.onmessage = ({ data }) => {
		const message = JSON.parse(data);
		const waiting = pending.get(message.id);
		if (!waiting) return;
		pending.delete(message.id);
		if (message.error) waiting.fail(new Error(`${waiting.method}: ${message.error.message}`));
		else waiting.ok(message.result);
	};
	await send("Page.enable");
	await send("Runtime.enable");

	for (const [i, [verb, ...args]] of steps.entries()) {
		const label = [verb, ...args].join(" ");
		try {
			const said = await act[verb](...args);
			const file = await shot(`${verb}-${args[0] ?? ""}`);
			const result = typeof said === "string" ? `ok ${said}` : "ok";
			appendFileSync(tsv, `${i + 1}\t${label}\t${result.replace(/\s+/g, " ")}\t${file}\n`);
			console.log(`step ${i + 1} ${label}: ${result} (${file})`);
		} catch (error) {
			const file = await shot(`FAILED-${verb}`).catch(() => "");
			appendFileSync(tsv, `${i + 1}\t${label}\tFAILED ${String(error.message).replace(/\s+/g, " ")}\t${file}\n`);
			console.error(`step ${i + 1} ${label}: FAILED ${error.message} (${file})`);
			status = 1;
			break;
		}
	}
} catch (error) {
	console.error(`browser: ${error.message}`);
	status = 1;
} finally {
	ws?.close();
	chrome.kill("SIGTERM");
	await until("Chrome to exit", () => chrome.exitCode !== null || chrome.signalCode !== null, 10000).catch(() => {});
}
process.exit(status);
