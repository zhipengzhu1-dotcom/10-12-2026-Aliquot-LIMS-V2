# Aliquot LIMS design overview

This document describes the agent society that will run a regulated pharmaceutical contract testing lab. Read it first. The decisions it rests on are in `docs/adr/`, the vocabulary is in `GLOSSARY.md`, and the mechanics of Mood and Merit are in `docs/design/vitality-and-merit.md`.

## Vision

A small society of Agents does the paperwork and the computation of the lab, from the Submission Form to the Report of Analysis. Each Agent has a Charter, a Persona, and a measured Vitality that changes what it may do. Agents earn Trust tiers through Reviews, train each other through Skills and Revisions, and rewrite their own Scripts in a Sandbox. The Operator sees every Agent's Mood and Merit live, and decides every Gate. Nothing leaves the Sandbox without the Operator's signature. Every action is an Event in one hash-chained Ledger, so the lab can show an inspector who did what, when, and why. The first slice runs on synthetic lab work. Real data connects only after the Operator has watched the society work.

## What exists today

The repository holds this design, the agent tooling configuration in `CLAUDE.md` and `docs/agents/`, and an untracked `Templates/` folder. The folder has five files, 188 KB in total. They are real records of the lab and carry Client names, contact names, Lot numbers, and Product Codes. ADR-0009 keeps them out of git. The synthetic generator copies their shape only.

| Template | What it is | Shape to copy |
|---|---|---|
| Sample receiving log (xlsx) | The Receiving Log, one yearly sheet plus one sheet per day | Columns #, Rec. DATE, Rec. Time, Product Code, PRODUCT NAME, TYPE, LOT#, CLIENT, EXP DATE, and QTY RECD. One row per container received. |
| Sample submission form (docx) | The Client-facing Submission Form | A header table for submitter, bill-to, and report-to. An 11 by 8 Sample table with number, description, Sample Type, TAT code, Lot, and Product Code. A lab-use-only receipt block with date, time, and received-by initials. |
| Report of Analysis, finished product (xlsx) | A Report of Analysis with static values | Letterhead, Client block, a metadata block (Lab Reference, product, Lot, Product Code, Product Type, document revision, date and time received, received by), a results table, and a signature area. |
| Report of Analysis, raw material (xlsx) | A heavy metals Report of Analysis | The same layout, but the metadata cells are formulas that read the Receiving Log workbook by external reference, such as `'[1]2026'!$L$22`. This link is how the lab traces a report to its receipt today. |
| Analyst worksheet (xlsx) | A Result Worksheet for average capsule weight | Columns #, Code, Name, Status, Lot#, weight of 20 capsules, weight taken, and average weight computed by `=F/20` style formulas. A Verifier recomputes these. |

None of the five files contains VBA. The macro workbooks, the SQL database, and the PDF reports and forms exist at the lab but are not yet available.

## The ten data shapes

Everything in the system derives from ten shapes. The Ledger holds Events. Every other shape is either the payload of an Event or a Projection computed from Events. The Ledger, its reducers, and these types are built before any Agent logic.

### 1. Event

An Event is one entry in the Ledger. Events are numbered, append-only, and hash-chained, so a changed or deleted Event breaks the chain. `kind` is a closed union. A Projection is a reducer over Event kinds, so an illegal state change has no Event that can express it.

```ts
type Actor = { tag: "Agent"; id: AgentId } | { tag: "Operator" };
type EventActor = Actor | { tag: "Conductor" };

type Event = {
	seq: Seq;
	ts: IsoTime;
	actor: EventActor;
	task_id?: TaskId;
	causation_id?: Seq;
	prev_hash: Sha256;
	hash: Sha256;
} & EventBody;

type EventBody =
	| { kind: "AgentRecruited"; payload: AgentDefinition }
	| { kind: "AgentDefinitionRevised"; payload: { definition: AgentDefinition } }
	| { kind: "TaskAssigned"; payload: { task_id: TaskId; assignee: AgentId } }
	| { kind: "GateDecided"; payload: GateDecision }
	| { kind: "VitalitySampled"; payload: Vitality }
	| { kind: "TurnStarted"; payload: { turn_id: TurnId; agent: AgentId; model: string; mood: Mood; policy: Policy } }
	| { kind: "TurnFinished"; payload: { turn_id: TurnId; usage: TurnUsage; outcome: TurnOutcome; tool_calls: number } };
	// and the rest of the set below

type TurnUsage = {
	input_tokens: number;
	output_tokens: number;
	cache_creation_tokens: number;
	cache_read_tokens: number;
	cost_usd: number;
};

type TurnOutcome =
	| { tag: "Completed" }
	| { tag: "MaxTurns" }
	| { tag: "Budget" }
	| { tag: "Error"; message: string };
```

The Ledger keeps every Projection: Org, Tasks, Gates, Rooms, Trust tier, work, Scripts, Runs, Artifacts, Turns, Training, and who proposed each Task. It builds them from its Events once when it opens (ADR-0001), and it advances each one by every Event it appends. A writer and a read-only opener build the same Projections from the same Events. Guards and commands read these Projections. No module outside the Ledger folds the Events.

Before the Ledger writes an Event, it advances the Projections by it and runs every guard. Each guard reads the Projections as they stood before the Event. A Projection that cannot apply the Event, or a guard, returns a reason. The Ledger then refuses the Event with `<Kind> refused: <reason>` and writes nothing. The guards always run on an append, and no option turns one off. Opening a Ledger does not run them again ([ADR-0012](../adr/0012-opening-a-ledger-does-not-rerun-the-guards.md)), so a Ledger written under older rules still opens. Only a stored Event that a Projection cannot apply makes the Ledger corrupt: opening it fails and names the `seq` and the reason. `ledger verify` reads only the hash chain, so it still reports on such a Ledger.

The Ledger stores its Events in SQLite, in `<home>/ledger.sqlite`, with one writer (ADR-0008). Tests use in-memory storage instead. Numbering, the hash chain, the guards, and the Projections all live in the Ledger, above the storage, so both storages run the same rules. SQLite stays the production storage, and the tests of persistence, the writer lock, and the chain on disk run on it.

The actor `Conductor` authors the tier Revisions that Merit and Gates require (ADR-0011), and records its own acts ([ADR-0013](../adr/0013-the-conductor-records-its-own-acts.md)): the `TurnStarted` and `TurnFinished` of each Turn it schedules, and the `ActionRefused` of each Tool call its hook refuses. The Ledger refuses any other Event it authors, and refuses a Turn Event or an `ActionRefused` from any actor but the Conductor. Only an Event's `actor` and a definition's `revised_by` can name it, so no payload can make the Conductor a reviewer, an escalation target, or a Skill author. No command takes the Conductor as its actor; `tools call` runs the Conductor's hook, which records a refusal as the Conductor would in a Turn.

The initial kinds are `AgentRecruited`, `AgentDefinitionRevised`, `AgentPaused`, `AgentResumed`, `AgentRetired`, `TaskProposed`, `TaskAssigned`, `TaskStarted`, `TaskHandedOff`, `TaskCompleted`, `TaskFailed`, `TaskEscalated`, `RoomOpened`, `MessageSent`, `HelpRequested`, `ScriptRegistered`, `ScriptRevised`, `RunStarted`, `RunFinished`, `ArtifactStored`, `EvaluationRecorded`, `ReviewRecorded`, `VitalitySampled`, `RestOrdered`, `GateRequested`, `GateDecided`, `HumanCoached`, `MemoryNoted`, and `SkillPublished`. Slice 1 adds `TurnStarted`, `TurnFinished`, and `ActionRefused`.

Only a domain's lifecycle module appends Events, and no command appends a raw one. Each verb mints the ids and derives `causation_id` from the Projections, so the Ledger records the true cause of every Event. `lifecycle-support.ts` holds what the verbs share: `Origin`, the actor and any cause from outside the domain; `Recorded`, the entity as the Event left it with the Event's seq, which each verb returns; and `readBack`, which reads that entity from the Projections after the append. A verb decides each refusal before it builds the Event, through the predicate the guard uses, and throws it with `orRefuse` from `append-guard.ts`. The lifecycle modules and the kinds each one appends:

| Lifecycle module | Event kinds |
|---|---|
| `org/lifecycle.ts` | `AgentRecruited`, `AgentDefinitionRevised`, `AgentPaused`, `AgentResumed`, `AgentRetired` |
| `task/lifecycle.ts` | `TaskProposed`, `TaskAssigned`, `TaskStarted`, `TaskHandedOff`, `TaskCompleted`, `TaskFailed`, `TaskEscalated`, `ReviewRecorded`, `HelpRequested` |
| `gate/lifecycle.ts` | `GateRequested`, `GateDecided`; only the Task lifecycle's `block` requests a Gate that blocks a Task |
| `room/lifecycle.ts` | `RoomOpened`, `MessageSent` |
| `sandbox/lifecycle.ts` | `ScriptRegistered`, `ScriptRevised`, `RunStarted`, `RunFinished`, `ArtifactStored` |
| `vitality/lifecycle.ts` | `VitalitySampled`, `RestOrdered` |
| `turn/lifecycle.ts` | `TurnStarted`, `TurnFinished`, always as the Conductor (ADR-0013) |
| `workflow/lifecycle.ts` | `EvaluationRecorded` |
| `training/lifecycle.ts` | `MemoryNoted`, `SkillPublished`, `HumanCoached` |
| `tools/lifecycle.ts` | `ActionRefused`, always as the Conductor (ADR-0013) |

The Ledger itself appends the Conductor's tier Revisions, as follow-ons and catch-ups (ADR-0011). Every kind has a lifecycle that appends it; none is reserved. Biome refuses an append call, and an `append` destructured from a Ledger or read by a computed key, in any non-test module except a `lifecycle.ts`, the Ledger's `ledger.ts`, and the test scenario in `test-support/`.

### 2. Agent definition

An Agent definition is a versioned document. A change is a Revision Event, never an edit in place. `trust_tier` always equals the projected Trust tier: the Ledger refuses a Recruitment or a Revision that records any other tier, whoever authors it. Granting a Skill is a Revision that adds its id to `skills`, and the Ledger refuses a Recruitment or a Revision whose `skills` names an id that no `SkillPublished` has published, naming that id.

One module, the Org lifecycle (`org/lifecycle.ts`), appends every Agent Event that the Operator or an Agent causes: it recruits, revises, pauses, resumes, and retires an Agent, and the seed recruits the starting roster through it. Each verb returns the Agent as the Event left it and the seq it appended. Each verb names the Event's cause in `causation_id`: the Agent's previous Org Event, which the Org Projection keeps, so a Recruitment names none, and for a retirement the `GateDecided` that approved its `RetireAgent` Gate, which the Gate Projection keeps. A caller names a cause only when it lies outside the Org; a retirement takes none, since its cause is always the approving decision. `retire` refuses an Agent that is not live, an actor other than the Operator, and a Gate that is unknown, undecided, rejected, of another kind or naming another Agent, before it builds the Event, through the predicate the Org guard uses. A retirement's reason defaults to the one in its `RetireAgent` Gate's payload, and is refused when neither gives one. The Conductor's tier Revisions stay Ledger follow-ons (ADR-0011).

```ts
type Role = "Director" | "Steward" | "Auditor" | "Supervisor" | "Specialist" | "Developer" | "Tester";

type AgentDefinition = {
	id: AgentId;
	version: number;
	name: string;
	role: Role;
	supervisor_id?: AgentId;
	persona: { voice: string; traits: string[]; quirk: string };
	charter: { purpose: string; responsibilities: string[]; forbidden: Action[]; escalation: string };
	tools: ToolName[];
	skills: SkillId[];
	memory_notes_ref: MemoryNotesRef;
	model: ModelName;
	capacity: number;
	trust_tier: TrustTier;
	revised_by: EventActor;
	revision_reason: string;
};

type Action =
	| "RunScript" | "TouchArtifact" | "DecideGate" | "AssignLabWork" | "AcceptOwnProposal"
	| "DoLabWork" | "TouchResults" | "VerifyOwnTeamRun" | "RunOutsideSandbox" | "WriteSystemOfRecord";
```

A Charter's `forbidden` list is a closed vocabulary of Actions, each one predicate over a Tool call and the Projections (see "Runtime topology"). The Ledger refuses a Recruitment or a Revision that forbids anything but an Action, naming it. A Ledger seeded before the vocabulary keeps the roster's phrases, such as `Run Scripts`: the Event boundary still reads a forbidden list of free text (ADR-0012), a Revision may carry those phrases over but add none, and the hook reads each phrase as its Action through the seed's table.

### 3. Task

A Task moves through a state machine. A Hand-off is a transition back to `Assigned` with a new assignee, not a state of its own. A Task that the Trust tier rules do not select for Review goes from `InProgress` straight to `Done`. A `Done` Task keeps its assignee, so the Task Projection alone says whose work a Review scores.

One module, the Task lifecycle (`task/lifecycle.ts`), appends every Task Event: it proposes, assigns, starts, hands off, escalates, completes, reviews, and fails a Task, and blocks one on a Gate it requests. Each verb mints the ids it needs from the Projections and returns the new Task and the seq it appended. Each verb also names the Event's cause in `causation_id`, from the Projections. The cause is the Task's previous Event, which the Task Projection keeps, or for a completion after Review the reviewer's `ReviewRecorded`. A caller names a cause only when it lies outside the Task, as the workflow tracer names the `EvaluationRecorded` it completes a Task on. A verb that the Projections already refuse, such as a Hand-off of a Task that is not `InProgress`, is refused before the verb builds an Event, in the same words. Completing a Task decides its Review: the verb asks the Trust tier whether the sample picks the Task. If it does, the Task goes `UnderReview` with the named reviewer, and a completion that names none is refused as sampled for Review. If it does not, the Review is skipped, and a named reviewer is unused. So `task complete <id>` takes only `--reviewer` and `--output`, and on a Task `UnderReview` it completes the Task after Review.

Two rules from `docs/design/vitality-and-merit.md` decide who takes a Task and who reviews it. Each is one predicate. The Ledger's guard refuses an Event with it, and the lifecycle verb refuses with it before it builds the Event, so both refusals use the same words.

- The reviewer rule (`vitality/reviewers.ts`). The role of the assignee decides the reviewer: either Supervisor for a Specialist, the Director for a Supervisor, and the Operator for the Director, the Steward, and the Auditor. The Auditor may review any Task, and a `Senior` or `Mentor` Agent may review an Agent on `Probation`. No one reviews their own Task. One predicate decides both the reviewer that a `TaskCompleted` names and the actor of a `ReviewRecorded`, so the two cannot disagree. A refusal names the assignee, its role, and who may review it. The design names no reviewer for the Developer and the Tester, so until they join in slice 2 they take the Specialists' rule.
- The Mood rule. A `TaskAssigned` or a `TaskHandedOff` is refused when the Policy of the new assignee's Mood does not let it accept Tasks: when it is `strained`, `overloaded`, `discouraged`, or `resting`. The refusal names the Agent and its Mood. The Mood comes from the Agent's latest `VitalitySampled`, with Rest and Tasks `InProgress` read from the Ledger as it stands. A guard reads no clock, so it cannot take a new sample. An Agent with no sample counts as one with no work, so it is `fresh` unless Rest or a Task `InProgress` changes that. A new sample or the end of Rest lifts the refusal.

A Help request is a `HelpRequested` Event with payload `{ task_id, to: Actor, question }`, by the assignee of a live Task (`Assigned`, `InProgress`, `UnderReview` or `Blocked`), to the Operator or a live Agent. The Task keeps its state, and the Event names the Task's previous Event as its cause. The Task Projection refuses a Help request from anyone but the assignee, and on a Task with no assignee or that is no longer live. It keeps each Task's Help requests as `{ seq, from, to, question }[]`, and every Agent each Task has been assigned to, which the Training guard reads for a Memory note. A reply is a Message in a Room, not an Event kind of its own.

```ts
type TaskState =
	| { tag: "Proposed" }
	| { tag: "Assigned"; assignee: AgentId }
	| { tag: "InProgress"; assignee: AgentId }
	| { tag: "UnderReview"; assignee: AgentId; reviewer: Actor }
	| { tag: "Blocked"; assignee: AgentId; gate: GateId }
	| { tag: "Escalated"; to: Actor }
	| { tag: "Failed"; reason: string }
	| { tag: "Done"; assignee: AgentId };

type TatClass = "Regular" | "Rush1to2Days" | "Rush3to4Days";

type Task = {
	id: TaskId;
	title: string;
	goal: string;
	inputs: ArtifactId[];
	outputs: ArtifactId[];
	state: TaskState;
	rubric_id: RubricId;
	priority: number;
	tat_class: TatClass;
	parent_task?: TaskId;
};
```

### 4. Artifact

An Artifact is a content-addressed file. Its Lineage lists the Artifacts it was made from. In the toy workflow, Lineage does the job that external-reference formulas do in the lab's workbooks today.

```ts
type ArtifactType =
	| "SubmissionForm" | "SubmissionRecord" | "ReceivingLogRow" | "LimsDatabase"
	| "WorkOrder" | "ResultWorksheet" | "VerificationRecord" | "ReportOfAnalysis"
	| "Other";

type Artifact = {
	id: ArtifactId;
	sha256: Sha256;
	media_type: string;
	artifact_type: ArtifactType;
	produced_by: { tag: "Run"; id: RunId } | { tag: "Operator" };
	lineage: ArtifactId[];
};
```

`sandbox lineage <artifact id>` walks an Artifact's Lineage back to the Artifacts that have none, one line per production, each naming the Run and Script version that produced it. The Auditor's Lineage check reads this walk.

A `LimsDatabase` Artifact is one version of the toy LIMS database (see "Toy System of record"), stored as `application/vnd.sqlite3`. Its Lineage names the record that changed it and the version before it, so the walk from any version reaches every Submission Form behind its rows.

### 5. Script and Run

A Script is a versioned Python program that runs only in the Sandbox. A new version replaces the previous one only after it handles every Fixture. A Run is one execution.

```ts
type Script = {
	id: ScriptId;
	version: number;
	name: string;
	owner_agent: AgentId;
	input_types: ArtifactType[];
	output_types: ArtifactType[];
	entrypoint: string;
	fixtures: ArtifactId[];
	image_digest: Sha256;
};

type Run = {
	id: RunId;
	script: { id: ScriptId; version: number };
	inputs: ArtifactId[];
	outputs: ArtifactId[];
	exit_code: number;
	stdout_ref: ArtifactId;
	stderr_ref: ArtifactId;
	duration_ms: number;
	eval_id?: EvaluationId;
};
```

One module, the Sandbox lifecycle (`sandbox/lifecycle.ts`), appends every Sandbox Event: it registers and revises a Script, starts and finishes a Run, and stores an Artifact. The Script registry, the runner and the Artifact store keep their own work, the copy of a Script's code, the `docker run` and the blob, and call the lifecycle to record it. Each verb mints the ids it needs from the Projections and returns what it appended with its seq. Each verb also names the Event's cause in `causation_id`, from the Projections. A `ScriptRevised` names the Script's previous version. An `ArtifactStored` that a Run produces, and the Run's `RunFinished`, name the Run's `RunStarted` and carry its Task. A caller names a cause only when it lies outside the Sandbox, as the workflow tracer names the `TaskStarted` it runs a Script on, so only starting a Run takes a cause and a Task from its caller. Storing bytes the Ledger already holds appends nothing unless a new Run produced them, and returns the `ArtifactStored` that already records them.

### 6. Vitality, Mood, and Policy

Vitality is measured from the Ledger, never reported by the Agent. The Conductor samples it once per Turn. Mood and Policy are pure functions.

```ts
type Vitality = {
	agent: AgentId;
	load: number;
	fatigue: number;
	friction: number;
	confidence: number;
	morale: number;
};

type Mood = "fresh" | "focused" | "strained" | "overloaded" | "discouraged" | "resting";

type Policy = {
	mayAcceptTasks: boolean;
	mayOfferHelp: boolean;
	mustHandOff: boolean;
	mustRequestHelp: boolean;
	mustNameBlocker: boolean;
	schedulable: boolean;
};

declare function moodOf(v: Vitality, restInEffect: boolean, hasTaskInProgress: boolean): Mood;
declare function policyOf(m: Mood): Policy;
```

`fatigue` is the sum of input, output and cache creation tokens of the Agent's `TurnFinished` Events in the trailing 5 hours, divided by its share of the Energy budget. Cache reads are recorded but not counted. The Turn Projection keeps each Agent's open Turn and every Turn with its start and finish times, and answers the tokens one Agent, or the whole society, used in a window.

One module, the Turn lifecycle (`turn/lifecycle.ts`), appends both Turn Events, always as the Conductor. Starting a Turn mints `TN-<n>` from the Turn Projection and records the model and the Mood and Policy that `vitality show` gives the Agent at that moment. It is refused for an Agent that is not live, is resting, is paused, or already has an open Turn. Finishing a Turn names its `TurnStarted` as the cause, and is refused for a Turn that is unknown or already finished. No command writes a Turn Event. `turn list` prints them.

One module, the Vitality lifecycle (`vitality/lifecycle.ts`), appends every Vitality Event. It samples a live Agent's Vitality from the Ledger and returns the sample and the seq it appended. A sample taken at the end of a Turn names that Turn's `TurnFinished` as its cause, which the caller gives because it lies outside Vitality. A sample from the command line names none. It orders Rest for an Agent or ends it, and returns the seq. A Rest order names the Agent's previous `VitalitySampled` or `RestOrdered` as its cause: the Vitality it acts on, or the Rest it ends. A Rest order that the Rest guard would refuse is refused before the verb builds an Event, in the same words.

### 7. Merit and Trust tier

A Review scores a completed Task on five dimensions. Merit is the rolling mean. The Trust tier is a Projection of Merit, tenure and approved `PromoteToMentor` Gates. One approved Gate covers one Promotion to Mentor.

The Trust tier Projection is the only place that decides the tier. It answers three questions: the Agent's tier, whether a Revision may record a given tier, and whether a Task must have a Review. After every append, in the same transaction, the Ledger appends one follow-on `AgentDefinitionRevised` for each live Agent whose `trust_tier` differs from its projected tier (ADR-0011). Each follow-on Revision has the actor `Conductor` as its actor and its `revised_by`, names the Event that caused it in `causation_id`, and gives the Merit or Gate change as its `revision_reason`. A refused follow-on refuses its cause too. So `org tree` prints the tier that Review sampling uses.

A Ledger written before ADR-0011 has definitions whose `trust_tier` lags the projected tier. When the Ledger opens for writing, before any caller appends, it appends one catch-up `AgentDefinitionRevised` by the `Conductor` for each Agent whose `trust_tier` lags, Retired Agents included, in its own transaction. A refused append after it leaves the catch-up in place. Each catch-up Revision names in `causation_id` the Event where the projected tier last changed to the tier it records: the Review, the `GateDecided`, or the Recruitment for an Agent that has held Probation since. Its `revision_reason` gives the Merit or Gate change at that Event and says that the Revision is recorded late. The projected tier changes only at a Review or a `GateDecided`, so the same rule decides the cause of a follow-on and of a late Revision: the Ledger refuses a Conductor Revision that names any Event other than the one where the projected tier last changed to the tier it records, and the refusal names that Event. A Ledger already caught up, or opened read-only, appends nothing.

```ts
type Score = 0 | 1 | 2 | 3;

type Review = {
	task_id: TaskId;
	reviewer: Actor;
	quality: Score;
	traceability: Score;
	boundary_adherence: Score;
	collaboration: Score;
	timeliness: Score;
	note: string;
};

type TrustTier = "Probation" | "Trusted" | "Senior" | "Mentor";
```

### 8. Gate

A Gate is a request for an Operator decision. Only the Operator emits `GateDecided`. The decision is the electronic signature record. The Ledger stamps `decided_at` with the decision Event's own `ts`, so the caller supplies no time and the signature time is the time the decision is recorded (ADR-0006).

One module, the Gate lifecycle (`gate/lifecycle.ts`), appends every Gate Event: it requests a Gate under the next free gate id and records the Operator's decision on it, and each verb returns the Gate and the seq it appended. A decision names the Gate's request as its `causation_id` and carries the payload hash the Operator checked, which the Ledger refuses, writing nothing, when it is not the stored one. A request that blocks a Task comes only from the Task lifecycle's `block`, which names the Task's previous Event as the request's cause. Biome refuses a call to the Gate lifecycle's `requestGateForTask` in any other module.

```ts
type GateKind = "Deploy" | "WriteSystemOfRecord" | "ExternalMessage" | "RetireAgent" | "PromoteToMentor";

type GateState = "Open" | "Approved" | "Rejected" | "Expired";

type GateDecision = {
	gate_id: GateId;
	decided_by: { tag: "Operator" };
	decided_at: IsoTime;
	payload_hash: Sha256;
	meaning: "approve" | "reject";
	reason: string;
};
```

### 9. Skill and Memory note

A Skill is a versioned Markdown procedure that any Agent can be granted. A Memory note is a private lesson that one Agent reads before similar Tasks. Coaching is the Operator's guidance to one Agent. All three are Events, so Training is auditable.

One module, the Training lifecycle (`training/lifecycle.ts`), appends `MemoryNoted`, `SkillPublished` and `HumanCoached`. Each verb decides its refusals before it builds the Event, through the predicate the Training guard uses, and returns what it recorded with the seq it appended.

- A Memory note is the Agent's own, on a Task the Agent has been assigned at some point, which the Task Projection keeps. The Ledger refuses a note by any other actor, and a note on a Task the Agent was never assigned. The note names the Task's previous Event, the outcome it learned from, as its cause.
- Publishing a Skill id appends its next version, starting at 1, with the actor as `author`. A version after the first names the version before it as its cause. The Ledger refuses a version that skips one, an author other than the actor, and a later version that names any other cause. A Skill id is a name the publisher chooses.
- Coaching is a `HumanCoached` Event with payload `{ agent_id, task_id?, note }`, by the Operator only, to an Agent in the Org. With a Task, it names the Task's previous Event as its cause.

The Training Projection (`training/projection.ts`) keeps each Agent's Memory notes and Coaching, and every version of each Skill, each with its seq.

```ts
type Skill = { id: SkillId; version: number; title: string; body_md: string; author: Actor };

type MemoryNote = { agent: AgentId; task_id: TaskId; lesson: string; applies_to: string[] };

type Coaching = { agent_id: AgentId; task_id?: TaskId; note: string };
```

### 10. Room and Message

A Room is where Agents talk (ADR-0010). The Lab Room, `RM-lab`, admits every recruited Agent that is not retired. Any Agent may open a `Listed` Room that names itself. The Operator is a member of every Room. A Message is a `MessageSent` Event projected for its reader. A reply names the Message it answers through the envelope's `causation_id`, which must be a Message in the same Room. One membership rule decides both who may say a Message and who may read a Room's history. One module, the Room lifecycle (`room/lifecycle.ts`), appends every Room Event. It opens a Room, which the Room's `opened_by` appends, and says a Message, returning the Room or the Message and the seq it appended. Neither Event names a cause, except a reply, whose `causation_id` is the Message it answers.

```ts
type RoomId = `RM-${string}`;

type Membership = { tag: "Everyone" } | { tag: "Listed"; agents: AgentId[] };

type Room = { id: RoomId; name: string; purpose: string; membership: Membership; opened_by: Actor; task_id?: TaskId };

// Events: { kind: "RoomOpened"; payload: { room: Room } } and { kind: "MessageSent"; payload: { room_id: RoomId; body: string } }
type Message = { seq: Seq; ts: IsoTime; actor: Actor; room_id: RoomId; body: string; causation_id?: Seq };
```

## Runtime topology

Five parts run on the Operator's Mac. Cloudflare carries only the Operator's browser traffic.

```
 Operator (browser)                     Anthropic API
      |  https, Cloudflare Access             ^
      v                                       | subscription login via `claude` CLI
 Cloudflare Tunnel  ---->  Conductor (TS) ----+
                            |  |  |
             SQLite ledger  |  |  +--> Agent turn = Agent SDK query() + MCP tools + hooks
             blob store ----+  |
                               +--> Docker sandbox: Python scripts, toy LIMS SQLite, artifacts
```

**Conductor.** The Conductor is a TypeScript process on Node. It is the only writer to the SQLite Ledger. It schedules Turns, enforces Policy, serves the interface, and streams Ledger Events over SSE. Each Turn is one `query()` call from `@anthropic-ai/claude-agent-sdk`. The Agent's Tools are an in-process MCP server that exposes Ledger-backed verbs (see **Tools** below). Each call runs through the hook, which refuses the Charter's forbidden Actions and what the Policy forbids, and the Conductor records each refusal. A `PreToolUse` hook denies every tool outside that server, because allow rules bypass `canUseTool`. `maxTurns` and `maxBudgetUsd` cap each Turn. The Conductor records each Turn as a `TurnStarted`, with the Agent's model, Mood and Policy, and a `TurnFinished`, with the usage the result reports, its outcome and its number of tool calls (ADR-0013). Fatigue is computed from the `TurnFinished` Events.

**Tools.** The Tools are one table (`tools/table.ts`). Each row names the Tool, its input shape, the lifecycle verb it calls with the Agent as actor, and the plain Action it performs. The MCP server of one Agent is built from the table with the Agent fixed in its context, never read from an input, so a Tool cannot act as another Agent. A Tool returns the Event its verb appended, or the Projection it read, as JSON text, and a refusal by the Ledger as its text. `run_script` on a workflow stage's Script records the stage's Evaluation after the Run, as the workflow tracer does, and returns it with the Run; it needs the Task the Evaluation scores. `tools/sdk.ts` is the only module that loads the SDK, and only when it builds a server.

| Tools | Verb |
|---|---|
| `read_tasks` | the Task Projection |
| `propose_task`, `assign_task`, `start_task`, `complete_task`, `fail_task`, `escalate_task`, `hand_off`, `review_task`, `request_help` | the Task lifecycle |
| `run_script` | the Sandbox runner, then the workflow lifecycle on a stage Script |
| `read_artifact`, `list_artifacts`, `lineage` | the Artifact Projection and blob store |
| `send_message`, `read_room`, `open_room` | the Room lifecycle and the membership rule |
| `note_memory`, `publish_skill` | the Training lifecycle |
| `propose_revision` | the Org lifecycle's `revise` |
| `request_gate` | the Gate lifecycle, or the Task lifecycle's `block` when it names a Task |
| `order_rest`, `end_rest` | the Vitality lifecycle |
| `verify_ledger` | the hash chain |

The hook runs before every Tool call. It checks the Charter first: the call is refused when it performs an Action the Agent's Charter forbids. Then the Policy: a call is refused when the Agent's Mood is not `schedulable`, and `start_task`, or `assign_task` to itself, when its Policy does not let it accept Tasks. The Conductor records a refusal as `ActionRefused` with payload `{ agent, tool, action: Action | "Policy", reason, task_id? }`, naming the Agent's open `TurnStarted` as its cause, so the Auditor and a Review's boundary score can see every attempt. A call the hook allows and the Ledger then refuses is not an `ActionRefused`; the Ledger's refusal text goes back to the model.

The Actions are one table of predicates (`tools/actions.ts`). A plain Action covers the Tools whose row names it. A relational one also reads the Projections. A Task works a stage when its inputs hold an Artifact of each of the stage's input types.

| Action | The calls it covers |
|---|---|
| `RunScript` | `run_script` |
| `TouchArtifact` | `read_artifact` |
| `DecideGate`, `RunOutsideSandbox`, `WriteSystemOfRecord` | none: only the Operator decides a Gate, `run_script` runs in the Sandbox, and the toy LIMS is not a System of record |
| `AssignLabWork` | `propose_task` or `assign_task` of a stage's Task |
| `AcceptOwnProposal` | `assign_task` or `start_task` on a Task the caller proposed |
| `DoLabWork` | `run_script` of a stage's Script, or `complete_task` on a stage's Task |
| `TouchResults` | the same, for stages 4 to 6 |
| `VerifyOwnTeamRun` | `run_script` of stage 5 on an Artifact of a Run whose Task's assignee is on the caller's team: the caller, an Agent that reports to it, or one that reports to a Supervisor the caller reports to, with the Specialists reporting to every Supervisor |

`tools list <agent>` prints the Tools an Agent may use given its Charter, and `tools call <agent> <tool> [json]` calls one through the hook.

**Authentication.** The Agent SDK spawns the `claude` CLI, which uses the subscription login when no API key is set. The SDK documentation, read on 2026-10-12 for SDK 0.3.296, lists subscription OAuth last in precedence. It says `claude setup-token` and `CLAUDE_CODE_OAUTH_TOKEN` authenticate scripts with a subscription. It also says third-party developers may not offer claude.ai login in products built on the SDK, and it says nothing about personal internal tools. Authentication is one module, so an API key with `maxBudgetUsd` can replace it. Two Turns run at the same time to start. The Energy budget is the subscription's 5-hour window.

**Sandbox.** One Docker image holds `python:3.13-slim`, openpyxl, python-docx, pdfplumber, reportlab, and sqlite3. Scripts and inputs mount read-only. Each Run writes to a fresh output directory. Containers run with `--network none`, `--cap-drop ALL`, and CPU, memory, and time limits. An Agent changes a Script by writing a new version into the Sandbox repository and running its Fixtures.

**Toy System of record.** A SQLite database in the Sandbox stands in for the lab's LIMS tables (samples, lots, work orders, results, and reports). It is synthetic, so it is not a System of record and Agents write to it without a Gate. Each data source declares in configuration whether it is a System of record. Connecting a real database turns the `WriteSystemOfRecord` Gate on by configuration, with no code change.

The toy LIMS database is an Artifact, never a mutable file. It is one SQLite file, `lims.sqlite`, of type `LimsDatabase`. A stage that changes it carries the latest `LimsDatabase` Artifact in the Ledger as an input, copies it inside the container, writes its rows, and outputs the next version. The Run's Lineage makes each version name the version before it and the record that changed it. When the Ledger holds no version, stage 2 (`log_receipt`) creates the database. The five tables' schema lives in one module, `sandbox/scripts/log_receipt/lims_schema.py`. It sits in that Script's directory because a container mounts only its own Script; later stages find the tables in the database they carry, and they add rows, not tables. The module sets `PRAGMA user_version` to the schema version, 1, and `log_receipt` and `create_work_order` refuse a carried database of another version.

Every table is `STRICT`. Every row's `source_artifact` holds the Artifact id of the document that produced the row, so a Lineage query can start from a row. Dates are ISO 8601 text (`YYYY-MM-DD`) and times are `HH:MM`.

| Table | Key | Columns | Written by |
|---|---|---|---|
| `lots` | `lot` | `product_code`, `product_name` (the Sample Description), `product_type`, `client` (the Submitted By company), `exp_date` (empty: the Submission Form gives no expiry), `source_artifact` | Stage 2, one row per Lot; a Lot already in the table keeps its first row |
| `samples` | `lab_reference` | `lot` (references `lots`), `container` (1, 2, 3 in the record's order), `qty_received` (1), `sample_type`, `tat_code`, `tat_class`, `date_submitted`, `date_received`, `time_received`, `received_by`, the six Submission Form fields (`company`, `contact`, `address`, `city`, `phone`, `email`) of each party as `submitted_by_*`, `bill_to_*` and `report_to_*`, `source_artifact` | Stage 2, one row per container |
| `work_orders` | `work_order`, `lab_reference`, `test` | `lab_reference` (references `samples`), `test`, `due_date`, `source_artifact` (the Receiving Log row) | Stage 3, one row per Sample and Test of a Work Order |
| `results` | `lab_reference`, `test` | `value` (a real number), `unit`, `source_artifact` | Stage 4 |
| `reports` | `lab_reference` | `issued_date`, `document_revision`, `source_artifact` | Stage 6 |

Stage 2 assigns each container a Lab Reference at receipt, `LR-<year received>-<n>` with n written as four digits or more. n is one more than the highest n for that year in `samples`, so the numbering continues from the carried version, and a container numbered in one version is never numbered again.

**Interface.** `aliquot serve` is the Conductor process. It holds the Ledger's writer for its lifetime. On Node's built-in `http`, with no framework, it serves four things: every Projection as JSON under `/api/`, the Ledger's Events as Server-Sent Events at `/api/events` with each Event's seq as its id, the Operator's actions at `POST /api/actions/<verb>`, and a single-page application. An action runs the lifecycle verb its command runs, as the Operator, and answers with the Event it appended or the Ledger's refusal. The application is plain TypeScript in `conductor/ui/`, compiled to ES modules with no bundler. Without Cloudflare Access, the Conductor serves `127.0.0.1` only. With Access, it admits only a request whose `Cf-Access-Jwt-Assertion` is signed by one of the team's published keys and names the application's audience and the Operator's email. README.md's Serve section lists the routes. Cloudflare Tunnel exposes the application at `agents.nitrolims-demo.com`, and Cloudflare Access admits only the Operator's email. We prefer a subdomain to the path `app.nitrolims-demo.com/development`. A path would route through whatever serves `app.` today and would share its cookies.

**Cost.** Everything on Cloudflare stays on the free tier, which covers Tunnel, Access for up to 50 users, and DNS. There is no Workers paid plan, no Containers, and no R2 beyond the free tier. The Ledger and the Artifact store stay on the Mac.

**Data boundary.** Real lab documents never leave the Mac, except as text inside prompts sent to Anthropic. The Operator must accept this before slice 3 or replace the model with a local one.

## The starting roster

Slice 1 starts with eight Agents. Their names are invented. Developer and Tester join in slice 2. Any other Recruitment is a Steward proposal.

| Name | Role | Reports to | Purpose | Forbidden actions | Persona |
|---|---|---|---|---|---|
| Odile | Director | Operator | Turns the lab's goals into Tasks for Supervisors, accepts or declines team-level proposals, and reports to the Operator weekly | Run Scripts, touch Artifacts directly, decide Gates | A calm planner who asks "what is the lab waiting on?" |
| Mabel | Steward | Operator | Watches Vitality, aggregates Merit, holds the Energy budget, orders Rest, proposes Recruitment and Retirement, and writes Revisions that Train the society | Assign lab work, accept its own proposals | Warm, and notices who has gone quiet |
| Thorne | Auditor | Operator, independent of the Director | Verifies the hash chain, checks that every required Gate was used, samples Reviews, and flags boundary violations and ALCOA+ gaps | Do lab work. Only the Operator may revise its definition. | Dry, precise, and unimpressed by speed |
| Pia | Supervisor, intake and Work Orders | Director | Owns the stages from Submission Form to Receiving Log to Work Order, and reviews the Specialists on them | Touch results or Reports of Analysis | Brisk, and likes checklists |
| Anselm | Supervisor, results and Verification | Director | Owns the stages from Result Worksheet to Verification to Report of Analysis, and makes sure a different Agent verifies each Result Worksheet | Verify a calculation from its own team's Run | Patient, and recomputes everything |
| Rin | Specialist, office documents | Supervisors | Reads and writes xlsx and docx, knows the template layouts, and later reads VBA | Run code outside the Sandbox | Tidy, and mildly obsessive about merged cells |
| Ines | Specialist, PDF | Supervisors | Extracts text from PDFs and renders PDFs, including supplier certificates, Submission Forms, and Reports of Analysis | Run code outside the Sandbox | Curious, and flags unreadable scans |
| Bram | Specialist, SQL | Supervisors | Reads and writes the toy LIMS database, writes migrations, and writes Lineage queries | Write to a System of record without a Gate | Blunt, and hates nulls |

The seed records each phrase of the "Forbidden actions" column as its Action: Odile `RunScript`, `TouchArtifact` and `DecideGate`; Mabel `AssignLabWork` and `AcceptOwnProposal`; Thorne `DoLabWork`; Pia `TouchResults`; Anselm `VerifyOwnTeamRun`; Rin and Ines `RunOutsideSandbox`; Bram `WriteSystemOfRecord`. Thorne's "Only the Operator may revise its definition" is a rule on others, which the Org guard enforces.

## The toy workflow

A synthetic generator invents Clients, products, Lots, and dates in the shape of the real templates. Each stage is a Script with Fixtures. Agents supervise the Runs, evaluate the outputs, and write new Script versions when an Evaluation fails. The Auditor samples the Lineage of each Report of Analysis back to its Submission Form.

| Stage | Input Artifact | Script | Output Artifact | Evaluation |
|---|---|---|---|---|
| 1. Submission | Synthetic Submission Form (docx) | `parse_submission` | Structured submission record (`SubmissionRecord`) | Every required field is present and every TAT code is valid. |
| 2. Receipt | Submission record, and the toy LIMS database it carries | `log_receipt` | Receiving Log row (`ReceivingLogRow`, xlsx) and the next toy LIMS database version (`LimsDatabase`) with the Sample rows | One row per container, the Lot and Product Code on every row match the record, the database has a `samples` row per row's Lab Reference and one `lots` row for the Lot, and every Lab Reference is new in this version. |
| 3. Work Order | Receiving Log row, and the toy LIMS database it carries | `create_work_order` | Work Order (`WorkOrder`, xlsx) with a Test for each Sample and a due date from TAT, and the next toy LIMS database version with the `work_orders` rows | The due date equals the one the Evaluation computes from the Receiving Log row's date and each Sample's TAT class, every Sample on the row has a Test, the Work Order number is new, and the `work_orders` rows agree with the document. |
| 4. Results | Work Order and synthetic weighings | `compute_results` | Result Worksheet (xlsx with `=F/20` style formulas) | The formulas are present and agree with the values. |
| 5. Verification | Result Worksheet | `verify_results`, run by a different Agent than stage 4 | Verification Record | The independent recomputation agrees within tolerance. |
| 6. Report | Verification Record and metadata | `render_roa` | Report of Analysis (xlsx and PDF) | Every metadata field traces to the Receiving Log row, and no field is typed by hand. |

The workflow is one table of stages in code (`workflow/stages.ts`). A row names the stage number and name, the Script, the input Artifact types the stage takes from the previous stage's outputs, the types it carries from the Ledger instead (the latest Artifact of that type that a Run of a `Done` Task wrote, such as the toy LIMS database from stage 2), its output types, the Agent that works it, the Agent that reviews it, and the Evaluation that scores the Run. An Evaluation reads the Run's input Artifacts and every Artifact the Run wrote, so stage 2 checks its rows against the record it read and its Lab References against the database version it carried. Adding a stage is adding a row, a Script directory, and an Evaluation. The table is refused at load when its rows are not stages 1, 2, 3 in order, or when stage 5 is worked by the Agent that works stage 4. The rows planned for slice 1:

| Stage | Script | Worked by | Reviewed by |
|---|---|---|---|
| 1 Submission | `parse_submission` | Rin | Pia |
| 2 Receipt | `log_receipt` | Bram | Pia |
| 3 Work Order | `create_work_order` | Bram | Pia |
| 4 Results | `compute_results` | Rin | Anselm |
| 5 Verification | `verify_results` | Bram | Anselm |
| 6 Report | `render_roa` | Ines | Anselm |

The workflow tracer (`workflow/tracer.ts`) runs the table on a Submission Form Fixture. Each stage is a Task worked by the stage's Agent, on the previous stage's outputs chosen by Artifact type, until the table ends or a Task fails. A stage whose input type is missing is refused before its Task is proposed. Each stage's `TaskProposed` names the previous stage's last `TaskCompleted` as its cause, so the causal chain runs unbroken from the Fixture to the last stage.

A carried type takes only an Artifact that a Run of a `Done` Task wrote. When a stage's Evaluation fails, its Task fails, and the database version its Run wrote stays in the Ledger as a record of the attempt; no later stage carries it, because no Evaluation accepted it. The next stage that carries the database takes the version before it.

Stage 2's Script writes a third file, `receipt.json` (typed `Other`): the Receiving Log sheet as the Script reads it back from the xlsx it saved. The Conductor has no xlsx reader and takes no new dependency for one, so the stage 2 Evaluation reads the rows from this read-back. It reads the record and both database versions itself, with `node:sqlite`.

**The due date rule.** A Work Order's due date is a number of business days after the date the Samples were received, set by their TAT class: 10 business days for `Regular`, 2 for `Rush1to2Days`, and 4 for `Rush3to4Days`. Business days are Monday to Friday. Slice 1 has no holiday calendar, so a holiday counts as a business day. A Sample received on a Saturday or Sunday starts counting from the next Monday, which is business day 1.

Stage 3 (`create_work_order`) writes one Work Order per Receiving Log row. It finds each Lab Reference on the row in the carried database's `samples` rows, which give the Sample's Lot, Product Code, Client, Sample type and TAT class, and it refuses a row whose Samples differ in any of these or in the date received. Each Sample gets the Tests its Sample type names. In slice 1, every Sample is a finished product and gets the Test "Average capsule weight". The Work Order number is `WO-<year received>-<n>`, numbered like the Lab Reference from the `work_orders` rows of the carried version. The sheet has a header block, which holds the Work Order number, Client, Lot, Product Code, date received, TAT class and due date. Below a blank row, it has one row per Sample and Test. The Script and the stage 3 Evaluation each hold the day counts in a table of their own and compute the date on their own, so a wrong date on either side fails the Evaluation. The Script also writes `work_order.json` (typed `Other`), which holds the Receiving Log row's Lab References and dates as the Script read them, and the Work Order as it reads it back from its xlsx. The Evaluation reads the Work Order from this read-back, and the TAT classes and `work_orders` rows of both database versions itself.

The workflow lifecycle (`workflow/lifecycle.ts`) appends every `EvaluationRecorded`. It mints the Evaluation id from the Projections, records the stage the Evaluation scores, and names the `RunFinished` of the Run it scores as the Event's cause. It refuses an Evaluation of a Run that has not finished, or for a Task that is no longer live, before it builds the Event, in the words of the workflow guard. The guard also refuses a new Evaluation that names no stage; one recorded before Evaluations named their stage still loads (ADR-0012). The workflow tracer appends nothing itself: it calls the Sandbox, the Task lifecycle, and this lifecycle.

## The Operator's interface

Every view is a Projection of the Ledger and updates live over SSE. No view stores its own state. Each view has a hash route (`#/org`, `#/flow`, `#/agent`, `#/rooms`, `#/scripts`, `#/gates`, `#/performance`, `#/ledger`). It fetches its Projections from `/api/` and fetches them again on every Event the stream delivers. A view's markup is a pure function of that JSON. Until its own ticket draws it, a view shows the JSON as it came.

| View | Shows | Operator actions |
|---|---|---|
| Org | A tree of Agents by supervisor, with a Mood badge, Trust tier, and load bar for each | Pause, resume, reassign, retire (opens a `RetireAgent` Gate), open an Agent |
| Flow | Tasks in one swimlane per stage, with causation arrows between Events, filtered by Task or Lot | Open a Task and read its Events |
| Agent | Charter, Persona, current Vitality and Mood, Merit history, Memory notes, and Skills | Open the Agent's Room, a Room whose only listed member is that Agent; author a Revision; give Coaching |
| Rooms | Every Room, private ones included, with its Messages live | Say a Message in any Room, open a Room |
| Scripts | Each Script with its versions, owner, Fixtures, and latest Runs | Open a Run, read its stdout and stderr |
| Gates | Open Gates, each with a diff of its payload | Approve or reject, with a reason |
| Performance | Merit per Agent over time, the rubric breakdown, the Energy budget, and Tasks by state | Export CSV |
| Ledger | Raw Events with the status of the hash chain | Verify the chain |

## Slices and roadmap

Each slice ends in something the Operator can check.

1. **Slice 0, the base.** Repository layout, the ten types, the Ledger with its hash chain and reducers, the Docker image, the synthetic generator, and CI that runs every Fixture. No Agents.
2. **Slice 1, the society on toy work.** The eight Agents run the toy workflow with live Vitality and Merit. The interface ships the Org, Flow, Agent, Gates, Performance, and Ledger views behind Tunnel and Access. The Mood thresholds get tuned against real data.
3. **Slice 2, building for Lab staff.** Developer and Tester join. They build the first web application for a lab task, probably a Sample receiving screen that replaces the Receiving Log sheet. The `Deploy` Gate goes live.
4. **Slice 3, real work.** A real data source connects behind the `WriteSystemOfRecord` Gate. Agents start reading VBA. Anonymized copies of the real templates become Fixtures.

## Risks and open questions

Each item states the default we take and the one word the Operator can send to reverse it.

| Risk or question | Default | Reverse word |
|---|---|---|
| The SDK documentation does not cover subscription login for a personal tool, and forbids third parties from offering claude.ai login in products. | Proceed for personal internal use and keep authentication swappable. The Operator may confirm with Anthropic. | `apikey` |
| Lab text reaches Anthropic inside prompts. | Accept for the toy phase. Real data waits for slice 3 and an explicit decision. | `local` |
| Subdomain or path on the Cloudflare zone. | `agents.nitrolims-demo.com`. | `path` |
| The templates hold real Client data and are untracked. | Ignore them in git and copy shapes only. | `anonymize`, which creates scrubbed copies for Fixtures |
| Nobody knows how many Turns the subscription allows at once. | Two at a time, measured in slice 1. | `serial`, which runs one Turn at a time |
| The Mood thresholds are guesses. | The numbers in `docs/design/vitality-and-merit.md`, tuned against slice 1 data. | `flat`, which treats every Agent as `fresh` until the data exists |
| Agents may talk in private Rooms. | Allowed. The Operator is a member of every Room and reads everything. | `open`, which forbids Listed Rooms |
| An Agent may write a Revision that removes one of its own forbidden Actions. | Allow it. The Conductor, not the Charter, enforces Gates, and the Auditor flags every Revision that removes a boundary. | `lock`, which puts such Revisions behind a Gate |
