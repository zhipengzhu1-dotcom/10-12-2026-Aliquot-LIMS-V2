# Aliquot LIMS

Aliquot LIMS is a society of AI agents that does the work of a regulated pharmaceutical contract testing lab, under the audit and control of one human operator. This glossary has two parts. The first part names the agent society. The second part names the lab work that the agents do.

## Agent society

### Organization

**Operator**:
The one human who runs the Conductor, decides every Gate, and reviews the Director, the Steward, and the Auditor. In the Ledger the Operator is the actor `Operator`.
_Avoid_: the human, user, admin, owner

**Lab staff**:
The people at the lab who will later use the web applications that Developers build. Lab staff are not actors in the Ledger.
_Avoid_: users, end users

**Agent**:
A member of the society that acts in Turns under one Agent definition.
_Avoid_: bot, worker, assistant, instance

**Turn**:
One bounded unit of agent activity that the Conductor schedules, from the prompt it sends to the result it records. The Conductor records each Turn in the Ledger as a `TurnStarted`, with the Agent's model, Mood and Policy, and a `TurnFinished`, with the usage that fatigue is computed from.
_Avoid_: session, step, tick

**Agent definition**:
The versioned document that says who an Agent is: its role, Charter, Persona, tools, Skills, capacity, and Trust tier.
_Avoid_: config, profile, agent file

**Charter**:
The part of an Agent definition that states the Agent's purpose, responsibilities, forbidden actions, and escalation rule.
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
An Agent that builds web applications for Lab staff. Developers join in slice 2.
_Avoid_: engineer, coder

**Tester**:
An Agent that uses a Developer's application as Lab staff would and records Evaluations of it. Testers join in slice 2.
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
Text that an Agent or the Operator posts in a Room, recorded as a `MessageSent` Event. A reply names the Message it answers through `causation_id`.
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
The links from an Artifact to the Artifacts it was made from.
_Avoid_: provenance, ancestry, dependency graph

### Execution

**Conductor**:
The single process that owns the Ledger, schedules Turns, enforces Policy, and serves the Operator's interface. In the Ledger the Conductor is the actor `Conductor`, which authors only the tier Revisions that Merit and Gates require and the records of its own acts, such as Turns.
_Avoid_: orchestrator, server, backend, scheduler

**Sandbox**:
The isolated environment, with no network access, where every Script and every piece of agent-written code runs.
_Avoid_: container, VM, jail

**Script**:
A versioned Python program with declared input and output Artifact types, owned by one Agent and run only in the Sandbox.
_Avoid_: tool, program, macro, job

**Run**:
One execution of one Script version on specific input Artifacts.
_Avoid_: execution, job, invocation

**Fixture**:
An Artifact with a known expected outcome that every new Script version must handle before it replaces the previous version.
_Avoid_: test data, sample (Sample is a lab term)

**Evaluation**:
An automatic check of a Run's outputs against stated criteria, scored from 0 to 1.
_Avoid_: test (Test is a lab term), grade, assessment

**System of record**:
A data source that the lab relies on as its official record. Writes to a System of record need a Gate. The toy LIMS database is not a System of record.
_Avoid_: production database, real DB, LIMS

### Merit

**Review**:
A score that a reviewer gives a completed Task on the five-dimension rubric: quality, traceability, boundary adherence, collaboration, and timeliness, each 0 to 3.
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
A named state computed from Vitality: `fresh`, `focused`, `strained`, `overloaded`, `discouraged`, or `resting`.
_Avoid_: emotion, feeling, status

**Policy**:
The set of actions that a Mood allows, such as accepting new Tasks or requiring a Hand-off.
_Avoid_: rules, behavior mode

**Rest**:
A period in which the Conductor schedules no Turns for an Agent, ordered by the Steward with a `RestOrdered` Event.
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
The form a Client completes to send Samples, listing each Sample, its Sample Type, its TAT code, and its Lot.
_Avoid_: request form, chain of custody, intake form

**Receiving Log**:
The lab's record of received containers, one row per container, with date, time, Product Code, Lot, Client, and quantity.
_Avoid_: intake sheet, receipt log

**Work Order**:
The lab document that lists the Tests and the due date for a group of Samples. A Work Order is not a Task.
_Avoid_: job, test request

**Test**:
One analytical method applied to an Aliquot, such as heavy metals or average capsule weight.
_Avoid_: assay, analysis

**Result Worksheet**:
The spreadsheet in which an analyst records weighings and readings and computes results by formula.
_Avoid_: bench sheet, calc sheet

**Verification**:
An independent recomputation and check of a Result Worksheet by someone other than its author. The output is a Verification Record.
_Avoid_: second check, double check, QC check, review (Review is a society term)

**Verifier**:
The person or Agent who performs a Verification. A Verifier is never the author of the Result Worksheet.
_Avoid_: checker, reviewer

**Report of Analysis**:
The signed document that the lab issues to a Client with the results for one Sample.
_Avoid_: CoA, Certificate of Analysis, ROA, final report. Clients may say CoA. A certificate that a supplier ships with a raw material is a different document.

**TAT**:
Turnaround time, coded on the Submission Form: 1 is regular, 2 is rush in 1 to 2 days, and 3 is rush in 3 to 4 days.
_Avoid_: SLA, deadline, priority (priority is a separate Task field)

**Lab Reference**:
The lab's internal identifier for a received Sample, printed as "BNY REF#" on current templates.
_Avoid_: ref number, BNY REF#, accession number
