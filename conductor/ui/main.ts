import { act, answerText, bodyOf } from "./actions.js";
import { onLedgerEvent } from "./sse.js";
import { escapeHtml, navigation, paramsOf, viewOf } from "./views.js";

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

/**
 * Draw `markup` in the page, keeping what the Operator had open, typed and
 * focused: a view is redrawn on every Event, mid-sentence or not.
 */
const draw = (markup: string) => {
	const open = [...page.querySelectorAll("details[open][id]")].map((d) => d.id);
	const typed = [
		...page.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
			"input[id], select[id]",
		),
	].map((field) => [field.id, field.value] as const);
	const focused = document.activeElement?.id;
	page.innerHTML = markup;
	for (const id of open) document.getElementById(id)?.setAttribute("open", "");
	for (const [id, value] of typed) {
		const field = document.getElementById(id);
		if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement)
			field.value = value;
	}
	if (focused) document.getElementById(focused)?.focus();
};

const render = async () => {
	const view = viewOf(location.hash);
	const params = paramsOf(location.hash);
	nav.innerHTML = navigation(view);
	try {
		const data =
			view.load === undefined
				? Object.fromEntries(
						await Promise.all(
							view.sources.map(async (s) => [s, await fetchJson(s)] as const),
						),
					)
				: await view.load(params, fetchJson);
		draw(view.render(view, data, params));
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
	answer.value = answerText(await act(String(fields.get("verb")), body));
});

// A view's action is a form whose markup carries its verb and fixed body.
page.addEventListener("submit", async (submitted) => {
	const target = submitted.target;
	if (!(target instanceof HTMLFormElement)) return;
	const verb = target.dataset.action;
	if (verb === undefined) return;
	submitted.preventDefault();
	const fields = [...new FormData(target)].map(
		([name, value]) => [name, String(value)] as const,
	);
	const result = await act(verb, bodyOf(target.dataset.body ?? "{}", fields));
	answer.value = answerText(result);
	// The Event may have redrawn the page already, and the form with it.
	const drawn = document.getElementById(target.id);
	if (result.ok && drawn instanceof HTMLFormElement) drawn.reset();
});

// A view's filter form names its route in `data-route`; submitting it moves
// the hash, so the filter lives in the URL and the view stays pure.
page.addEventListener("submit", (submitted) => {
	const filter = submitted.target;
	if (!(filter instanceof HTMLFormElement) || !filter.dataset.route) return;
	submitted.preventDefault();
	const params = new URLSearchParams();
	for (const [key, value] of new FormData(filter)) {
		if (typeof value === "string" && value.trim() !== "") {
			params.set(key, value.trim());
		}
	}
	const query = params.toString();
	location.hash =
		query === "" ? filter.dataset.route : `${filter.dataset.route}?${query}`;
});

page.addEventListener("click", (clicked) => {
	if (
		clicked.target instanceof Element &&
		clicked.target.closest("[data-reload]")
	)
		void refresh();
});

addEventListener("hashchange", () => void refresh());
onLedgerEvent(() => void refresh());
void refresh();
