import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event, NewEvent } from "./events.js";
import { AgentId, TaskId } from "./ids.js";
import { openLedger } from "./ledger.js";
import { fold, type Projection } from "./reduce.js";

const odile = AgentId.parse("A-odile");
const rin = AgentId.parse("A-rin");

/** Who holds each Task and how many Events each kind has. */
type Board = {
	assignees: Record<string, string>;
	kinds: Record<string, number>;
};

const board: Projection<Board> = {
	init: { assignees: {}, kinds: {} },
	reduce: (state: Board, event: Event): Board => {
		const kinds = {
			...state.kinds,
			[event.kind]: (state.kinds[event.kind] ?? 0) + 1,
		};
		if (event.kind === "TaskAssigned" || event.kind === "TaskHandedOff") {
			const to =
				event.kind === "TaskAssigned"
					? event.payload.assignee
					: event.payload.to;
			return {
				kinds,
				assignees: { ...state.assignees, [event.payload.task_id]: to },
			};
		}
		return { ...state, kinds };
	},
};

const assigned = (n: number, assignee: AgentId): NewEvent => ({
	actor: { tag: "Operator" },
	kind: "TaskAssigned",
	payload: { task_id: TaskId.parse(`T-${n}`), assignee },
});

const handedOff = (n: number): NewEvent => ({
	actor: { tag: "Agent", id: odile },
	kind: "TaskHandedOff",
	payload: {
		task_id: TaskId.parse(`T-${n}`),
		from: odile,
		to: rin,
		reason: "at capacity",
	},
});

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "aliquot-reduce-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

// A toy board over Tasks that were never proposed; the Task guards would
// refuse it, and fold itself is what is under test.
const noDomainRules = [] as const;

describe("fold", () => {
	it("folds Events into a Projection in seq order", () => {
		const ledger = openLedger({ home, writer: true, guards: noDomainRules });
		ledger.append(assigned(1, odile));
		ledger.append(assigned(2, odile));
		ledger.append(handedOff(1));
		const events = ledger.all();
		ledger.close();

		expect(fold(events, board.reduce, board.init)).toEqual({
			assignees: { "T-1": "A-rin", "T-2": "A-odile" },
			kinds: { TaskAssigned: 2, TaskHandedOff: 1 },
		});
	});

	it("gives equal Projections from two folds of the same Ledger", () => {
		const writer = openLedger({ home, writer: true, guards: noDomainRules });
		for (let n = 1; n <= 60; n++) {
			writer.append(assigned(n, odile));
			if (n % 4 === 0) writer.append(handedOff(n));
		}
		const first = fold(writer.all(), board.reduce, board.init);
		writer.close();

		const reader = openLedger({ home, writer: false });
		const second = fold(reader.events(), board.reduce, board.init);
		reader.close();

		expect(second).toEqual(first);
		expect(first.kinds).toEqual({ TaskAssigned: 60, TaskHandedOff: 15 });
		expect(board.init).toEqual({ assignees: {}, kinds: {} });
	});
});
