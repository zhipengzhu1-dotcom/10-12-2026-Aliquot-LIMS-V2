import { act } from "./actions.js";
import { onLedgerEvent } from "./sse.js";
import { escapeHtml, navigation, viewOf } from "./views.js";

const element = <T extends Element>(selector: string): T => {
	const found = document.querySelector<T>(selector);
	if (found === null) throw new Error(`index.html has no ${selector}`);
	return found;
};

const nav = element<HTMLElement>("nav");
const page = element<HTMLElement>("main");
const form = element<HTMLFormElement>("#action");
const answer = element<HTMLOutputElement>("#answer");

const fetchJson = async (route: string): Promise<unknown> => {
	const res = await fetch(`/api/${route}`);
	if (!res.ok) throw new Error(`/api/${route} answered ${res.status}`);
	return res.json();
};

const render = async () => {
	const view = viewOf(location.hash);
	nav.innerHTML = navigation(view);
	try {
		const data = Object.fromEntries(
			await Promise.all(
				view.sources.map(async (s) => [s, await fetchJson(s)] as const),
			),
		);
		page.innerHTML = view.render(view, data);
	} catch (error) {
		page.innerHTML = `<p role="alert">${escapeHtml(String(error))}</p>`;
	}
};

// Events arrive in bursts, such as a replay after a reconnect: render once
// for the burst, then once more if another Event or route change came in.
let rendering = false;
let again = false;
const refresh = async () => {
	if (rendering) {
		again = true;
		return;
	}
	rendering = true;
	try {
		do {
			again = false;
			await render();
		} while (again);
	} finally {
		rendering = false;
	}
};

form.addEventListener("submit", async (submitted) => {
	submitted.preventDefault();
	const fields = new FormData(form);
	let body: unknown;
	try {
		body = JSON.parse(String(fields.get("body")));
	} catch (error) {
		answer.value = `The body is not JSON: ${String(error)}`;
		return;
	}
	const result = await act(String(fields.get("verb")), body);
	answer.value = result.ok
		? `Appended ${result.event.kind} at seq ${result.event.seq}`
		: `${result.status}: ${result.text}`;
});

addEventListener("hashchange", () => void refresh());
onLedgerEvent(() => void refresh());
void refresh();
