import { describe, expect, it } from "vitest";
import { clockFace, hasEntered, laboratoryOf, markEntered } from "./access.js";

const memory = (): Record<string, string | undefined> => ({});

describe("the Access landing", () => {
	it("shows once per session: a fresh session has not entered, and ENTER remembers it", () => {
		const session = memory();
		expect(hasEntered(() => session)).toBe(false);
		markEntered(() => session);
		expect(hasEntered(() => session)).toBe(true);
	});

	it("renders without storage: a session store that throws shows the landing and ENTER still works", () => {
		const refused = () => {
			throw new DOMException("denied", "SecurityError");
		};
		expect(hasEntered(refused)).toBe(false);
		expect(() => markEntered(refused)).not.toThrow();
	});

	it("names the laboratory by the Room every Agent belongs to", () => {
		const rooms = {
			rooms: {
				"RM-qc": { name: "QC", membership: { tag: "Agents" } },
				"RM-lab": { name: "Lab", membership: { tag: "Everyone" } },
			},
			messages: [],
		};
		expect(laboratoryOf(rooms)).toBe("Lab Room · RM-lab");
		expect(laboratoryOf({ rooms: {}, messages: [] })).toBeUndefined();
	});

	it("draws the clock in local time with the weekday and date", () => {
		const face = clockFace(new Date(2026, 9, 13, 9, 5, 7));
		expect(face).toEqual({
			time: "09:05",
			seconds: "07",
			stamp: "09:05:07",
			date: "Tue · 13 Oct 2026",
		});
	});
});
