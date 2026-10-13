import { describe, expect, it } from "vitest";
import { navigation, paramsOf, VIEWS, viewOf } from "./views.js";

describe("the interface's views", () => {
	it("routes each of the eight views by its hash, and any other hash to Org", () => {
		expect(VIEWS.map((v) => v.name)).toEqual([
			"org",
			"flow",
			"agent",
			"rooms",
			"scripts",
			"gates",
			"performance",
			"ledger",
		]);
		expect(viewOf("#/gates").title).toBe("Gates");
		expect(viewOf("#/nowhere").name).toBe("org");
		expect(navigation(viewOf("#/ledger"))).toContain(
			'<a href="#/ledger" aria-current="page">Ledger</a>',
		);
	});

	it("routes a hash with parameters to its view and hands the view the parameters", () => {
		expect(viewOf("#/ledger?before=51").name).toBe("ledger");
		expect(viewOf("#/agent?id=A-rin").name).toBe("agent");
		expect(paramsOf("#/ledger?before=51").get("before")).toBe("51");
		expect(paramsOf("#/ledger").get("before")).toBeNull();
	});

	it("shows a view's Projection JSON with every Message body as text, not markup", () => {
		const rooms = viewOf("#/rooms");

		const page = rooms.render(rooms, {
			rooms: { messages: [{ body: "<img src=x onerror=alert(1)>" }] },
		});

		expect(page).toContain("<h2>/api/rooms</h2>");
		expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(page).not.toContain("<img");
	});
});
