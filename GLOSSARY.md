# Aliquot LIMS

Aliquot LIMS is the automation engine behind the LIMS of a regulated pharmaceutical contract testing lab (ADR-0017). A society of AI agents does the lab's paperwork and computation, under the audit and control of named people acting as the Operator. This glossary has two parts. The first part names the agent society. The second part names the lab work that the agents do.

## Agent society

### Organization

**Operator**:
The role of the named person who runs the Conductor, decides every Gate, and reviews the Director, the Steward, and the Auditor. More than one person may act as the Operator, each under their own email. In the Ledger the Operator is the actor `Operator` with the person's email, and every Event the person authors names that email (ADR-0019). An Event written before #74 names no email and reads as `Operator (unnamed)`.
_Avoid_: the human, user, admin, owner

**Lab staff**:
The people at the lab who will later use the web applications that Developers build. Lab staff are not actors in the Ledger.
_Avoid_: users, end users

**Agent**:
A member of the society that acts in Turns under one Agent definition.
_Avoid_: bot, worker, assistant, instance

**Turn**:
One bounded unit of agent activity that the Conductor schedules: one call to the model, with a prompt built from the Ledger and the Agent's Tools as its only tools, from the prompt it sends to the result it records. The Conductor records each Turn in the Ledger as a `TurnStarted`, with the Agent's model, Mood and Policy, and a `TurnFinished`, with the usage that fatigue is computed from, then samples the Agent's Vitality naming that `TurnFinished`.
_Avoid_: session, step, tick

**Agent definition**:
The versioned document that says who an Agent is: its role, Charter, Persona, tools, Skills, capacity, and Trust tier.
_Avoid_: config, profile, agent file

**Charter**:
The part of an Agent definition that states the Agent's purpose, responsibilities, forbidden Actions, and escalation rule.
_Avoid_: system prompt, instructions, job description

**Persona**:
The part of an Agent definition that sets the Agent's voice, traits, and quirk. A Persona changes how an Agent speaks, never what its Policy allows.
_Avoid_: personality, character

**Director**:
The Agent that turns the lab's goals into Tasks for Supervisors and reports to the Operator.
_Avoid_: CEO, manager, lead

**Steward**:
The Agent that watches Vitality, aggregates Merit, holds the Energy budget, and proposes Recruitment, Retirement, and Revisions.
_Avoid_: HR, wellbeing officer, trainer

**Auditor**:
The Agent that verifies the Ledger and checks that every rule and Gate was followed. It reports to the Operator and is independent of the Director.
_Avoid_: QA, compliance bot, inspector

**Supervisor**:
An Agent that owns a group of workflow stages and reviews the Specialists who work on them.
_Avoid_: manager, team lead

**Specialist**:
An Agent that does hands-on work in one area, such as office documents, PDFs, or SQL.
_Avoid_: worker, expert, individual contributor

**Developer**:
An Agent that builds web applications for Lab staff. Developers join after the first edition.
_Avoid_: engineer, coder

**Tester**:
An Agent that uses a Developer's application as Lab staff would and records Evaluations of it. Testers join after the first edition.
_Avoid_: QA

**Recruitment**:
The addition of a new Agent to the society, recorded as an `AgentRecruited` Event.
_Avoid_: spawning, hiring, creation

**Retirement**:
The permanent removal of an Agent from scheduling. Retirement needs a Gate.
_Avoid_: deletion, firing, termination

**Revision**:
A new version of an Agent definition, recorded as an `AgentDefinitionRevised` Event with an author and a reason. Earlier versions stay in the Ledger.
_Avoid_: edit, update, patch

**Promotion**:
A move of an Agent to a higher Trust tier or to a new role. Promotion to Mentor needs a Gate.
_Avoid_: level up, upgrade

**Demotion**:
A move of an Agent to a lower Trust tier. Any boundary score of 0 in a Review causes a Demotion of one tier.
_Avoid_: downgrade, penalty

### Work

**Task**:
A unit of work for one Agent, with a goal, input Artifacts, an assignee, and a state. A Task is not a Work Order.
_Avoid_: ticket, job, work item

**Hand-off**:
The move of a Task from its assignee to another Agent, which returns the Task to `Assigned`.
_Avoid_: transfer, reassignment, delegation

**Escalation**:
The move of a Task up the reporting line because the assignee cannot finish it within its Charter.
_Avoid_: bump, raise

**Help request**:
A request in which the assignee of a live Task asks the Operator or another Agent for help on it, with a question, recorded as a `HelpRequested` Event. The reply is a Message in a Room.
_Avoid_: ask, ping, SOS

**Room**:
A named place where a listed set of Agents, or every Agent, exchange Messages. The Operator is a member of every Room. A Room is a Projection of `RoomOpened` and `MessageSent` Events.
_Avoid_: channel, chat room, chat, group, DM, thread

**Lab Room**:
The one Room every Agent belongs to, seeded with the roster, where the society stays on the same page.
_Avoid_: general, lobby, all-hands

**Message**:
Text that an Agent or the Operator posts in a Room, or that the Conductor posts in reply to a Message it took for a Chain, recorded as a `MessageSent` Event. A reply names the Message it answers through `causation_id`.
_Avoid_: chat, post, ping, DM

**Gate**:
A request for an Operator decision on an action that touches the world outside the Sandbox or changes the society in a way that cannot be undone. The decision Event is the electronic signature record.
_Avoid_: approval, checkpoint, sign-off

### Record

**Ledger**:
The append-only, hash-chained sequence of Events. The Ledger is the only source of truth.
_Avoid_: log, audit log, event log, history

**Event**:
One numbered entry in the Ledger, with an actor, a kind, and a payload.
_Avoid_: entry, record, message

**Projection**:
State computed from the Ledger by a deterministic reducer, such as the org chart, Moods, Trust tiers, or a Task's state. The Ledger keeps every Projection and advances it by each Event it appends. A Projection is never stored as truth.
_Avoid_: read model, cache, derived table

**Artifact**:
A content-addressed file that a Run or the Operator produced, with a type and a Lineage.
_Avoid_: output, blob, attachment

**Lineage**:
The links from an Artifact to the Artifacts it was made from. The Auditor samples the Lineage of a Report of Analysis, which runs through every stage back to the Submission Form Fixture.
_Avoid_: provenance, ancestry, dependency graph

### Execution

**Conductor**:
The single process that owns the Ledger, schedules Turns, enforces Policy, runs Chains, and serves the Operator's interface. `aliquot serve` runs it. In the Ledger the Conductor is the actor `Conductor`, which authors only the tier Revisions that Merit and Gates require, the records of its own acts, such as Turns, the Tool calls its hook refuses, and the Scheduler's assignments, and the Events of its Chains.
_Avoid_: orchestrator, server, backend, scheduler

**Chain**:
The work an Operator's receipt or results Message starts, which the Conductor runs in `aliquot serve` with no Turn and no model (ADR-0021): it stores the Message, runs the parse Script, runs the stages on one Task, and replies to the Message in the Lab Room. Each of its Events names its cause, back to the Message.
_Avoid_: engine, fast path, automation

**Scheduler**:
The part of the Conductor that runs the society on its own inside `aliquot serve`. Every Tick it assigns the Proposed Tasks no one assigned within a Tick: a stage's Task to the Agent that works the stage when that Agent is active, any other Task by the weighted pick. It starts Turns for the Agents that have something to do, within the Policy, the Energy budget and the number of Turns allowed at once. It prints one line per decision and keeps the last Tick's decisions for the Interface.
_Avoid_: cron, job queue

**Tick**:
One pass of the Scheduler, every `--tick` (15 seconds by default). A Tick is not a Turn: it decides which Turns start.
_Avoid_: heartbeat, polling loop

**Interface**:
The single-page application the Conductor serves to the Operator: one view per hash route, each showing Projections that update on every Event from the Event stream, and the Operator's actions.
_Avoid_: dashboard, frontend, portal

**Chat view**:
The view of the Interface, `#/chat`, that shows the Lab Room's Messages newest last, each with who said it, and says the Operator's text in the Lab Room. It is how the Operator talks to the whole team, and how the Operator reports received Samples in free text.
_Avoid_: inbox, messenger, console

**Event stream**:
The Server-Sent Events at `/api/events`: one for each Event the Ledger appends, with the Event's seq as its id, so a client that reconnects resumes from the Ledger.
_Avoid_: feed, websocket

**Operator action**:
A lifecycle verb the Operator runs through the Interface, as `POST /api/actions/<verb>`, which appends the same Event the matching command appends, always as the Operator, named by the person the request comes from.
_Avoid_: RPC, endpoint

**Tool**:
A Ledger-backed verb that an Agent calls during a Turn, such as `run_script` or `send_message`, always as itself. The Conductor serves each Agent its Tools from one in-process MCP server, and runs every call through the hook first.
_Avoid_: plugin, capability

**Action**:
One entry of the closed vocabulary a Charter forbids, such as `RunScript` or `VerifyOwnTeamRun`. Each Action is one predicate over a Tool call and the Projections. The hook refuses a call that performs an Action the Agent's Charter forbids, and the Conductor records the refusal as an `ActionRefused` Event.
_Avoid_: restriction, prohibition

**Sandbox**:
The isolated environment, with no network access, where every Script and every piece of agent-written code runs.
_Avoid_: container, VM, jail

**Script**:
A versioned Python program with declared input and output Artifact types, owned by one Agent and run only in the Sandbox.
_Avoid_: tool (a Tool is a verb an Agent calls), program, macro, job

**Run**:
One execution of one Script version on specific input Artifacts.
_Avoid_: execution, job, invocation

**Fixture**:
An Artifact with a known expected outcome that every new Script version must handle before it replaces the previous version. A Submission Form is a Fixture when its expected record lies beside it; the blank form the generator fills is not. A Fixture the workflow cannot finish yet carries a known gap: the stage that stops it and the issue that will close it.
_Avoid_: test data, sample (Sample is a lab term)

**Evaluation**:
An automatic check of a Run's outputs against stated criteria, scored from 0 to 1. Each Evaluation names the stage of the toy workflow it scores.
_Avoid_: test (Test is a lab term), grade, assessment

**Toy workflow**:
The practice version of the lab's work, from Submission Form to Report of Analysis, as one table of stages that the workflow tracer runs on a Fixture.
_Avoid_: pipeline

**Stage**:
One row of the toy workflow: a Script, the Artifact types it takes and produces, the Agent that works it, the Agent that reviews it, and its Evaluation. Each stage runs as one Task.
_Avoid_: phase, step

**System of record**:
A data source that the lab relies on as its official record. Writes to a System of record need a Gate. The toy LIMS database is not a System of record.
_Avoid_: production database, real DB, LIMS

**Parallel run**:
The way slice 3 meets the lab's System of record (ADR-0018): the Conductor writes a Shadow beside the lab's own records and never writes the System of record, and the Operator judges the Comparisons before any real write.
_Avoid_: dry run, shadow mode, pilot

**Shadow**:
A copy of a System of record in its real layout, with the rows the Conductor would have written added, as an Artifact. Stage 2 writes the Shadow Receiving Log (`ShadowReceivingLog`) from a fresh read of the lab's Receiving Log workbook, whose path the home names. The real workbook is only ever read.
_Avoid_: shadow copy, staging copy, draft workbook

**Comparison**:
The field-by-field report of a Shadow's rows beside the rows the lab entered by hand for the same Samples: each row matched, differing (each field with both values), missing in the lab's, or missing in the Shadow. It is an Artifact of type `Comparison`, produced by the Run that made it.
_Avoid_: reconciliation, diff report

**Toy LIMS database**:
The synthetic SQLite database that stands in for the lab's LIMS tables in the toy workflow. It is an Artifact of type `LimsDatabase`, never a mutable file: a stage carries the latest version that a Run of a `Done` Task wrote and outputs the next one, whose Lineage names the version before it. A version from a Task whose Evaluation failed is never carried. It is not a System of record.
_Avoid_: lab database, live database

### Merit

**Review**:
A score that a reviewer gives a completed Task on the five-dimension rubric: quality, traceability, boundary adherence, collaboration, and timeliness, each 0 to 3. The role of the assignee decides the reviewer: a Supervisor reviews a Specialist, the Director reviews a Supervisor, and the Operator reviews the Director, the Steward, and the Auditor. The Auditor may review any Task, and a `Senior` or `Mentor` Agent may review an Agent on `Probation`.
_Avoid_: grade, rating, feedback, verification (Verification is a lab term)

**Merit**:
The rolling mean of an Agent's Review scores.
_Avoid_: reward, points, karma, performance score

**Trust tier**:
An Agent's standing (`Probation`, `Trusted`, `Senior`, or `Mentor`), projected from Merit and tenure. The Trust tier sets how often the Agent's Tasks get a Review and how much work the Conductor offers it.
_Avoid_: level, rank, seniority

**Mentor**:
The highest Trust tier. A Mentor may revise other Agents' Charters and propose Recruitment.
_Avoid_: lead, coach (Coaching is something the Operator does)

### Vitality

**Vitality**:
The measured state of one Agent, a vector of load, fatigue, friction, confidence, and morale. Agents never report their own Vitality.
_Avoid_: wellbeing, health, energy, feelings

**Mood**:
A named state computed from Vitality: `fresh`, `focused`, `strained`, `overloaded`, `discouraged`, or `resting`. Mood is flat in the first edition: every live Agent is `fresh`, whatever its Vitality or Rest.
_Avoid_: emotion, feeling, status

**Policy**:
The set of actions that a Mood allows, such as accepting new Tasks or requiring a Hand-off. While Mood is flat, every Agent has the normal Policy of `fresh`.
_Avoid_: rules, behavior mode

**Rest**:
A period ordered for an Agent by the Steward with a `RestOrdered` Event. While Mood is flat, Rest is recorded but does not stop the Agent's Turns; pausing does.
_Avoid_: sleep, cooldown, break

**Energy budget**:
The amount of model usage that the whole society may consume in one rolling 5-hour window. The Steward holds it.
_Avoid_: quota, token budget, rate limit

### Training

**Training**:
Any of the four ways an Agent improves: Skills, Revisions, Memory notes, and Coaching. Training never means fine-tuning a model.
_Avoid_: learning, fine-tuning

**Skill**:
A versioned Markdown procedure that any Agent can be granted, such as "parse a Submission Form". Each version is a `SkillPublished` Event, and a Skill is granted by a Revision that lists its id.
_Avoid_: playbook, recipe, SOP

**Memory note**:
A private lesson that an Agent attaches to the outcome of a Task it worked and reads before similar Tasks, recorded as a `MemoryNoted` Event.
_Avoid_: memory, lesson, journal

**Coaching**:
Direct guidance from the Operator to one Agent, about a Task when there is one, recorded as a `HumanCoached` Event.
_Avoid_: feedback, training, mentoring

## Lab

**Client**:
A company that submits Samples to the lab and receives Reports of Analysis.
_Avoid_: customer, sponsor

**Sample**:
Material that a Client submits for testing, identified by a Lab Reference.
_Avoid_: specimen, item

**Aliquot**:
A measured portion taken from a Sample for one Test. The project takes its name from this term.
_Avoid_: subsample, portion, split

**Lot**:
One production batch of a product, identified by the Client's lot number.
_Avoid_: batch

**Product Code**:
The Client's identifier for a product.
_Avoid_: SKU, item code

**Product Type**:
The pack configuration of a finished product, such as count and container.
_Avoid_: package, format

**Sample Type**:
The class of a Sample: FP (finished product), IP (in-process), RM (raw material), or R&D.
_Avoid_: category, material type

**Submission Form**:
The form a Client completes to send Samples, listing each Sample, its Sample Type, its TAT code, and its Lot, one Sample per line. In the toy workflow, stage 1 reads every line into the record.
_Avoid_: request form, chain of custody, intake form

**Receiving Log**:
The lab's record of received containers, one row per container, with date, time, Product Code, Lot, Client, and quantity.
_Avoid_: intake sheet, receipt log

**Work Order**:
The lab document that lists the Tests and the due dates for a group of Samples. A Work Order is not a Task. In the toy workflow, stage 3 writes one Work Order per Receiving Log row, as `WO-<year received>-<n>`: a row per Sample, Test and analyte with the Sample's Lot and due date, the Work Order due with its last Sample.
_Avoid_: job, test request

**Test**:
One analytical method applied to an Aliquot, such as heavy metals or average capsule weight.
_Avoid_: assay, analysis

**Test definition**:
What the lab knows about a Test: its name, the words in a Client's request that map to it, and whether it has analytes. In the toy workflow, stage 3 maps each request in a Sample line's TESTS REQUESTED to a Test definition by its words and refuses a request it cannot map, quoting it. It knows two: Average capsule weight and Nitrosamine impurities.
_Avoid_: test type, test code

**Nitrosamine impurities**:
The Test for N-nitrosamines in a drug substance or product. Its analytes are the nitrosamines the Client names: a small nitrosamine such as NDMA or NDEA, or a drug-substance-related one named "N-nitroso-…". A request that says nitrosamines without naming one is refused, asking which. Stage 4 computes each analyte's content in ppm (ng per mg) and, with a maximum daily dose, its intake in ng/day, and judges it against its limit in the limit's own unit.
_Avoid_: NDSRI testing, nitrosamine screen

**Reporting limit**:
The lowest concentration of an analyte the method reports as a number, in ng/mL, given with each reading. A reading below it is reported "< RL" and passes any limit.
_Avoid_: LOQ, detection limit

**Analyte**:
The substance a Test measures in a Sample, one row of the Work Order each, with its limit from the form's LIMITS. A Test such as Average capsule weight has none.
_Avoid_: compound, component

**Acceptable intake**:
A nitrosamine limit given as the most a patient may take in per day, in ng/day. The other form of limit is a concentration in the material, in ppm or ng/g. Stage 3 keeps a limit in neither form as its text and marks it `unread:` on the Work Order.
_Avoid_: daily limit, TTC

**Result Worksheet**:
The spreadsheet in which an analyst records weighings and readings and computes results by formula.
_Avoid_: bench sheet, calc sheet

**Notebook reference**:
Where the analyst's laboratory notebook records a set of weighings, as the notebook and page, such as `NB-07 p.31`. The Operator gives it in a results Message. In the toy workflow, `parse_results_message` writes it on each weighing, the Result Worksheet holds it in row 4 of its header block, and the Report of Analysis holds it below the signature area. Weighings with no notebook reference, as the Fixtures' are, leave both out.
_Avoid_: notebook page, NB ref, lab book reference

**Verification**:
An independent recomputation and check of a Result Worksheet by someone other than its author. The output is a Verification Record. In the toy workflow, stage 5 is the Verification, and its Task's title starts `Stage 5 Verification`. Its Script, `verify_results`, evaluates each average on the worksheet's own cells and compares it with the weighings within 0.0001 g. It writes a Verification Record with a `pass` or `fail` verdict.
_Avoid_: second check, double check, QC check, review (Review is a society term)

**Verifier**:
The person or Agent who performs a Verification. A Verifier is never the author of the Result Worksheet. The workflow guard enforces this in the Ledger. It refuses a `TaskAssigned` or `TaskHandedOff` that gives a Verification Task to an Agent that was ever assigned the Task whose Run wrote a Result Worksheet among the Verification's inputs. The refusal names both Tasks and the Agent. The stage table also refuses a stage 5 worked by the Agent that works stage 4.
_Avoid_: checker, reviewer

**Report of Analysis**:
The signed document that the lab issues to a Client with the results for one Sample. In the toy workflow, stage 6 renders it as xlsx and PDF from one structure, both typed `ReportOfAnalysis`, from a Verification Record whose verdict is pass. Every metadata value is read from the Sample's Receiving Log row or its `samples` row, never typed by hand, and the `reports` row names the PDF. It leaves the lab only through an `ExternalMessage` Gate. `aliquot sandbox lineage <report id>` walks its Lineage back to the Submission Form.
_Avoid_: CoA, Certificate of Analysis, ROA, final report. Clients may say CoA. A certificate that a supplier ships with a raw material is a different document.

**TAT**:
Turnaround time, coded on the Submission Form: 1 is regular, 2 is rush in 1 to 2 days, and 3 is rush in 3 to 4 days. Each code names a TAT class, `Regular`, `Rush1to2Days` or `Rush3to4Days`, which sets a Work Order's due date (`docs/design/overview.md`, "The due date rule").
_Avoid_: SLA, deadline, priority (priority is a separate Task field)

**Lab Reference**:
The lab's internal identifier for a received Sample, printed as "BNY REF#" on current templates. In the toy workflow, stage 2 assigns one to each container at receipt, as `LR-<year received>-<n>`.
_Avoid_: ref number, BNY REF#, accession number
