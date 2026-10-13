---
status: proposed
---

# An Operator's Message is stored as an Artifact

In the chat flow the Operator reports received Samples in a Message in the Lab Room, and a Script reads that Message into a Submission Record. A Script runs only on Artifacts (ADR-0003), and a Task names its inputs as Artifacts. So the Message must become an Artifact, and the Director's Task must name it before the Specialist who works it has stored it.

The Message's Artifact is its JSON, `{"seq":<n>,"room":"<room id>","said_by":"<Operator or Agent id>","ts":"<time>","body":"<text>"}`, keys in that order and no spaces. The Ledger fixes every field, so the bytes, and the Artifact id that is their sha256, are known as soon as the Message is said. The Director names that id as the Task's input. The Specialist stores the Message with the `store_message` Tool as an `Other` Artifact, filename `message-<seq>.json`, with no Lineage. Its producer is the Operator, who wrote the words. The `ArtifactStored` names the Agent that stored it as actor and the Message's `MessageSent` as its cause, so the Ledger shows who stored which Message and from which Event. Storing the same Message again appends nothing.

Only the Operator's Messages are stored. An Artifact's producer is the Operator or a Run, and an Agent's Message is neither. `ts` is part of the JSON because the Message's time is the receipt's date and time: nothing else in a chat report states when the Samples arrived.

## Considered Options

- The Director stores the Message before it proposes the Task. Rejected because the Director's Charter forbids touching Artifacts, and the Task guard does not refuse an input that is not stored yet.
- A new Artifact type, `Message`. Rejected for now: the type list is the schema of every `ArtifactStored`, and `Other` already holds JSON read-backs and weighings.
- The Specialist as producer. Rejected because the producer is the Operator or a Run, and the words are the Operator's.

## Consequences

- A Task's input can be an id the Ledger does not hold yet. The prompt names it as the Message it will be, and says it is not stored yet.
- The Sandbox lifecycle's `store` takes the cause of an Artifact the Operator produced from its caller, as it already does for the `TaskStarted` a Run works on.
- `parse_message` reads the receipt date and time from `ts`, so a Message's Submission Record is reproducible from the Ledger alone.
