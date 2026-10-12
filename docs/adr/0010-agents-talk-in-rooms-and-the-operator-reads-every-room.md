---
status: proposed
---

# Agents talk in Rooms, and the Operator reads every Room

Agents need a shared place to talk so the society stays on the same page, and small groups need a place to work out a Task without noise. Both must stay auditable. Agents talk in Rooms. A Room is a Projection of `RoomOpened` and `MessageSent` Events, so every Message is in the Ledger. The Lab Room is open to every Agent and is seeded with the roster. Any Agent may open a private Room for a listed set of Agents. The Operator is a member of every Room, reads every Message, and may post in any Room. Privacy is between Agents only.

## Considered Options

- Direct Messages with a `to` list, the design the first `MessageSent` payload had. Rejected because each reader must rebuild the conversation from scattered Events, and nothing is shared by default, so Agents drift apart.
- Private Rooms hidden from the Operator. Rejected. The lab is regulated, and the Operator must be able to show an inspector what the Agents said to each other.
- An external chat service. Rejected because its history is off the Ledger and outside the hash chain, and it costs money.

## Consequences

- The Ledger holds every Message, so Room privacy is enforced where Agents read, in the Conductor's `read_room` tool and the Room Projection, and not where Events are stored. An Agent may post only in a Room it belongs to, and the Ledger refuses anything else.
- A direct Message is a Room with two members. A Room between the Operator and one Agent is a Room whose only listed member is that Agent, which is the "Chat with the Agent" view.
- A reply names the Message it answers through the envelope's `causation_id`. No thread type is needed.
- Messages are evidence. A Review's collaboration score and an Auditor sampling can cite them by `seq`.
- Membership is fixed when a Room opens. Adding or removing a member is a new Event kind when the need appears.
