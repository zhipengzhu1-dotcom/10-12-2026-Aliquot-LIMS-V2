---
status: proposed
---

# The Conductor runs the Chain a Message starts

The one live run of the chat flow (docs/design/live-run-2026-10-chat.md) took 91 s from the Operator's receipt to the reply, for 1.1 s of Script Runs, and spent about 600,000 tokens on Messages about Messages. The next step after a receipt or results Message is always the same, so a model adds nothing to the path but time and tokens. The owner asked for the result "under 10 seconds", then "even quicker, instantly".

So the Conductor runs that work itself, as a Chain, the moment the Operator says the Message in `aliquot serve`. A Message whose words mark it as results (a notebook, a numbered container, results) starts the results Chain; one that says what was received starts the receipt Chain. The Conductor takes the Message by storing it as an `Other` Artifact (ADR-0015), naming its `MessageSent`, before the Operator's request returns. It then runs the parse Script on it, with no Task. When the parse refuses, the Conductor replies with the parse's reason and does nothing more. Otherwise it proposes one Task on the Message and the parse's outputs, assigns it to the Agent the stage table names for the Chain's first stage, starts it, runs each stage's Script with its Evaluation, and completes it naming the reviewer the reviewer rule gives. The results Chain then requests an `ExternalMessage` Gate naming the PDF, as the Specialist did. Last, the Conductor replies to the Operator's Message in the Lab Room: the Lab References and the Work Order's due date, or the Gate id and the report's two Artifact ids. Chains run one at a time, since each reads the toy LIMS database the one before wrote.

These are the Conductor's acts, as ADR-0013 records the Conductor's own acts: it took the Message, and no Agent and not the Operator decided each step. Each of them names its cause, so the causes of every Event of a Chain reach the Operator's `MessageSent`. The Ledger refuses a Chain's Event by the Conductor that names no cause, a stored Message by the Conductor whose cause is not an Operator's `MessageSent`, and a Message by the Conductor that does not reply to a Message it took. Every other rule applies as it does to an Agent's act of the same kind: the Task state machine, the Review sample, the Evaluation's Run and Task, the Gate. The Conductor still belongs to no Room and reads none.

A Message the Conductor takes, and its reply, wake no Agent: the Scheduler counts neither as a new Message, and the Director's prompt does not list it. A Message whose words mark no Chain goes to the Agents as before. The Agents' part is review beside the path: the Chain's Task goes `UnderReview` when the sample picks it, and its reviewer reviews it on a Turn it gets for another reason.

## Considered Options

- A model reads the Message and the Conductor runs the rest. Rejected for this ticket: the parse Scripts read a receipt and results by labelled patterns, and a model call adds seconds. A model for a Message the patterns cannot read is a later decision.
- The Agents keep the path, with fewer of them woken. Rejected: a Tick, a Turn slot and a model round trip still stand between the Message and the reply.
- One Task per stage, as the workflow tracer and the Agents' path use. Rejected: the owner chose one Task per Chain, so the Flow view and Lineage show one unit of work per Message. The Verifier rule, which keeps stage 5 apart from stage 4, binds the Agents who take a Verification Task; a Chain's Task is worked by the Conductor's Scripts, not by a Verifier.
- The Conductor as a member of the Lab Room. Rejected: it would then read every Room, and a member may say anything. It may only answer the Messages it took.

## Consequences

- `aliquot serve` answers a receipt or results within 1 s of the Message, running each Run in its warm Sandbox (ADR-0020), and needs no model for it, so it answers under `--no-schedule` too. The bound is one named constant, `REPLY_BOUND_MS`.
- A receipt or results said with `room say` on the command line is not taken: the Chain runs only in the serve. It goes to the Agents as before.
- A Chain that stops at a stage fails its Task, naming why, and the reply says where it stopped.
- On SIGINT or SIGTERM the serve waits for the running and queued Chains before it closes the Ledger. If the serve dies while a Chain runs, the taken Message has no reply and no Agent takes it up. The Operator says it again.
- The first Run after the serve starts also starts its warm container, so the first Message's reply includes that start; it was 503 ms when first measured.
- A Chain's carried Artifacts, such as the toy LIMS database, are the latest of their type a Run wrote whose Evaluation passed, so a Chain's Task need not be Done for the next Chain to carry its database.
