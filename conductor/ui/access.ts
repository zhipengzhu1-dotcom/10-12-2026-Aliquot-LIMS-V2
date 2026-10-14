/**
 * The Access landing: a lock frame shown once per tab before the shell.
 * There is no password: Cloudflare Access vouched for the person before the
 * page loaded, so the landing names that person and ENTER only opens the shell.
 */

import { UNNAMED_OPERATOR } from "./markup.js";

/** The key in the tab's storage that says the landing was passed. */
export const ENTERED_KEY = "aliquot.access.entered";

/** The tab's storage, read and written by key as a Storage object allows. */
type TabStore = Record<string, string | undefined>;

/**
 * Whether this tab already passed the landing. Storage that is missing or
 * refuses access, as in a private window, counts as not passed.
 */
export const hasEntered = (store: () => TabStore): boolean => {
	try {
		return store()[ENTERED_KEY] === "1";
	} catch {
		return false;
	}
};

export const markEntered = (store: () => TabStore): void => {
	try {
		store()[ENTERED_KEY] = "1";
	} catch {}
};

const two = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/** The clock as the landing draws it, in the browser's local time. */
export const clockFace = (now: Date) => ({
	time: `${two(now.getHours())}:${two(now.getMinutes())}`,
	seconds: two(now.getSeconds()),
	stamp: `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`,
	date: `${DAYS[now.getDay()]} · ${two(now.getDate())} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`,
});

type RoomsJson = {
	readonly rooms?: Readonly<
		Record<
			string,
			{ readonly name: string; readonly membership: { readonly tag: string } }
		>
	>;
};

/** The laboratory as the Conductor knows it: the Room every Agent belongs to. */
export const laboratoryOf = (json: unknown): string | undefined => {
	const rooms = Object.entries((json as RoomsJson).rooms ?? {});
	const lab = rooms.find(([, room]) => room.membership.tag === "Everyone");
	return lab === undefined ? undefined : `${lab[1].name} Room · ${lab[0]}`;
};

/** The person acting as the Operator, from `/api/operator`. */
export const operatorOf = (json: unknown): string => {
	const email = (json as { readonly email?: unknown }).email;
	return typeof email === "string" ? email : UNNAMED_OPERATOR;
};

/**
 * A static double helix for the landing's viewBox of 1200 by 400: two strands
 * half a turn apart, tapering at both ends, with a rung every 16 units and
 * every seventh rung lit.
 */
export const helixMarkup = (): string => {
	const turn = 380;
	const strand = (offset: number) => (x: number) => {
		const taper = 0.45 + 0.55 * Math.sin((Math.PI * (x - 40)) / 1120);
		return 200 + 150 * taper * Math.sin((2 * Math.PI * x) / turn + offset);
	};
	const front = strand(0);
	const back = strand(Math.PI);
	const xs = Array.from({ length: 141 }, (_, i) => 40 + i * 8);
	const line = (y: (x: number) => number) =>
		`M${xs.map((x) => `${x},${y(x).toFixed(1)}`).join("L")}`;
	const rungs = Array.from({ length: 70 }, (_, i) => 48 + i * 16).map(
		(x, i) =>
			`<line class="rung${i % 7 === 3 ? " lit" : ""}" x1="${x}" y1="${front(x).toFixed(1)}" x2="${x}" y2="${back(x).toFixed(1)}"/>`,
	);
	return `<g>${rungs.join("")}<path class="strand back" d="${line(back)}"/><path class="strand" d="${line(front)}"/></g>`;
};

const byId = (id: string): HTMLElement => {
	const found = document.getElementById(id);
	if (found === null) throw new Error(`index.html has no #${id}`);
	return found;
};

/**
 * Show the landing unless this tab passed it, and open the shell on
 * ENTER. `get` reads an `/api` route for the laboratory's name and the person.
 */
export const showAccess = (get: (route: string) => Promise<unknown>): void => {
	const body = document.body;
	const store = () => sessionStorage;
	if (hasEntered(store)) {
		body.dataset.access = "open";
		return;
	}
	body.dataset.access = "locked";
	const opened = new Date();
	byId("access-terminal").textContent = location.host;
	byId("access-time").textContent = clockFace(opened).stamp;
	document
		.querySelector("#access .helix")
		?.insertAdjacentHTML("beforeend", helixMarkup());
	const tick = () => {
		const face = clockFace(new Date());
		byId("access-clock").textContent = face.time;
		byId("access-seconds").textContent = face.seconds;
		byId("access-date").textContent = face.date;
	};
	tick();
	const timer = setInterval(tick, 1000);
	get("rooms")
		.then((json) => {
			const lab = laboratoryOf(json);
			if (lab !== undefined) byId("access-laboratory").textContent = lab;
		})
		.catch(() => {});
	get("operator")
		.then((json) => {
			byId("access-operator").textContent = operatorOf(json);
		})
		.catch(() => {});
	const button = byId("access-enter");
	const enter = () => {
		markEntered(store);
		clearInterval(timer);
		removeEventListener("keydown", onKey);
		body.dataset.access = "entered";
	};
	const onKey = (key: KeyboardEvent) => {
		if (key.key === "Enter" && key.target === document.body) enter();
	};
	button.addEventListener("click", enter);
	addEventListener("keydown", onKey);
	button.focus();
};
