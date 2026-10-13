import { sha256Hex } from "../hash.js";
import { ArtifactId, type Seq } from "../ids.js";
import type { Projections } from "../projections.js";
import type { Message } from "../room/projection.js";
import { refusal } from "../room/projection.js";
import { openArtifacts } from "../sandbox/artifacts.js";
import { type Actor, actorText } from "../types/actor.js";
import { type ToolContext, ToolRefused } from "./tool.js";

/** The Script that reads a stored Message into a Submission Record. */
export const PARSE_MESSAGE = "parse_message";

/** The Script that reads a stored results Message and its Work Order into the weighings stage 4 reads. */
export const PARSE_RESULTS_MESSAGE = "parse_results_message";

/**
 * A Message as an Artifact holds it: `{"seq","room","said_by","ts","body"}`
 * in that order, with no spaces. The bytes are fixed by the Message, so its
 * Artifact id is known before it is stored, and a Task can name it.
 */
export const messageJson = (m: Message): string =>
	JSON.stringify({
		seq: m.seq,
		room: m.room_id,
		said_by: actorText(m.actor),
		ts: m.ts,
		body: m.body,
	});

/** The id the Message has once stored: the sha256 of its JSON. */
export const messageArtifactId = (m: Message): ArtifactId =>
	ArtifactId.parse(sha256Hex(messageJson(m)));

/** The Operator's Messages by the Artifact id each has once stored. */
export const messagesById = (
	projections: Projections,
): ReadonlyMap<ArtifactId, Message> =>
	new Map(
		projections.rooms.messages
			.filter((m) => m.actor.tag === "Operator")
			.map((m) => [messageArtifactId(m), m]),
	);

/**
 * Store the Message at `seq` as an `Other` Artifact of its JSON, by `actor`,
 * naming the Message's MessageSent as the cause. Only the Operator's
 * Messages are stored: an Artifact's producer is the Operator or a Run, and
 * an Agent's Message is neither. Storing it again appends nothing.
 */
export const storeMessage = (ctx: ToolContext, actor: Actor, seq: Seq) => {
	const { rooms, org } = ctx.ledger.projections;
	const message = rooms.messages.find((m) => m.seq === seq);
	if (message === undefined) {
		throw new ToolRefused(`seq ${seq} is not a Message`);
	}
	const reason = refusal(rooms, org, message.room_id, actor);
	if (reason !== undefined) throw new ToolRefused(reason);
	if (message.actor.tag !== "Operator") {
		throw new ToolRefused(
			`seq ${seq} was said by ${actorText(message.actor)}; only the Operator's Messages are stored as Artifacts`,
		);
	}
	return openArtifacts(ctx).store(
		Buffer.from(messageJson(message)),
		{
			artifact_type: "Other",
			media_type: "application/json",
			produced_by: { tag: "Operator" },
			lineage: [],
			filename: `message-${seq}.json`,
		},
		{ actor, cause: seq },
	);
};
