import { z } from "zod";

/**
 * The closed vocabulary of a Charter's forbidden actions. Each Action has one
 * predicate over a Tool call and the Projections, in `tools/actions.ts`.
 */
export const Action = z.enum([
	"RunScript",
	"TouchArtifact",
	"DecideGate",
	"AssignLabWork",
	"AcceptOwnProposal",
	"DoLabWork",
	"TouchResults",
	"VerifyOwnTeamRun",
	"RunOutsideSandbox",
	"WriteSystemOfRecord",
]);
export type Action = z.infer<typeof Action>;

export const isAction = (text: string): text is Action =>
	(Action.options as readonly string[]).includes(text);
