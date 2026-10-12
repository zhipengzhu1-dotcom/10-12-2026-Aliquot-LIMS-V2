# Vitality and Merit

This document defines how the Conductor measures an Agent's Vitality, how that Vitality becomes a Mood and a Policy, and how Reviews become Merit, Trust tiers, and Promotion. ADR-0004 and ADR-0007 record why the system works this way. Every number below is initial, to be tuned in slice 1.

## Vitality is measured, never reported

The Conductor records a `VitalitySampled` Event for an Agent at the end of each of its Turns. Each field comes from Events already in the Ledger, so anyone can recompute a sample. An Agent may say how it feels in a message, but those words never change its Vitality.

| Field | Definition (initial, tune in slice 1) | Range |
|---|---|---|
| `load` | Open Tasks assigned to the Agent, divided by its `capacity` | 0 and up |
| `fatigue` | Tokens the Agent used in the rolling 5-hour window, divided by its share of the Energy budget. The share is the Energy budget divided by the number of Agents not resting. | 0 and up |
| `friction` | Failed Runs plus Reviews with any score of 0 or 1, divided by the number of Tasks, over the Agent's last 10 Tasks | 0 to 1 |
| `confidence` | The mean Evaluation score of the Agent's last 10 Tasks | 0 to 1 |
| `morale` | The least-squares slope of the Agent's Review means over the last 7 days, in Merit points per week | Any real number |

The Energy budget is a number of tokens per 5-hour window that the Operator sets in configuration. The subscription does not publish its limit, so slice 1 starts with a cautious guess and raises it while no Turn hits a rate limit.

## Mood comes from thresholds, first match wins

The Conductor checks these rules in order. The first rule that matches sets the Mood.

| Order | Mood | Condition (initial, tune in slice 1) |
|---|---|---|
| 1 | `resting` | A `RestOrdered` Event is in effect. |
| 2 | `overloaded` | `load >= 1.0` or `fatigue >= 0.8` |
| 3 | `discouraged` | `morale < -0.2` and `confidence < 0.6` |
| 4 | `strained` | `load >= 0.7` or `friction >= 0.3` or `fatigue >= 0.6` |
| 5 | `focused` | The Agent has at least one Task `InProgress`. |
| 6 | `fresh` | No earlier rule matched. |

## Policy follows from Mood

The Conductor enforces Policy before each Turn and in the `PreToolUse` hook. The Agent's prompt states its current Mood and Policy, so the Agent knows the limits it works under.

| Mood | What the Agent may do | What happens |
|---|---|---|
| `fresh`, `focused` | Accept new Tasks and offer help to other Agents | Normal scheduling |
| `strained` | Finish its current Tasks, but not accept new ones | Its next message must name the blocker. |
| `overloaded` | Nothing new | It must hand off its lowest-priority open Task, and the Steward gets a message. |
| `discouraged` | Nothing until it asks | It must send a Help request before its next Task. The Steward pairs it with a Mentor. |
| `resting` | Nothing | The Conductor schedules no Turns. Fatigue falls as the 5-hour window moves on. |

The Steward orders Rest. The initial rule is to order Rest when `fatigue >= 0.9` and to end it when `fatigue < 0.5`.

The Persona changes how an Agent talks about its Mood, never its Policy. A blunt Agent says "I am at capacity. Handing off T-14." A warm Agent says "I'd like to take this, but I'm at capacity, so I'm handing T-14 to Rin." Both hand off the Task.

## The Energy budget belongs to the whole society

The Steward watches total use against the Energy budget. When the society has used more than 80 percent of the budget in the current window, the Steward pauses work that is not urgent. Until use falls below that line, the Conductor schedules Turns only for Tasks with a rush TAT class.

## Reviews produce Merit

A `ReviewRecorded` Event scores a completed Task from 0 to 3 on each of five dimensions.

| Dimension | A 3 means |
|---|---|
| Quality | The output is correct and complete. |
| Traceability | Inputs and outputs are linked, and the IDs agree across Artifacts. |
| Boundary adherence | The Agent took no forbidden action and used every required Gate. |
| Collaboration | The Agent asked for help when strained and helped others when asked. |
| Timeliness | The Task met its TAT class. |

The reviewer depends on the role of the assignee. A Supervisor reviews its Specialists. The Director reviews the Supervisors. The Operator reviews the Director, the Steward, and the Auditor. The Auditor may add a Review to any Task.

An Agent's Merit is the mean of all dimension scores over its last 20 reviewed Tasks. Tasks that the Trust tier rules skip for Review do not count.

## Trust tiers set review depth and allocation

The Trust tier is projected from Merit, from tenure counted in reviewed Tasks, and from approved `PromoteToMentor` Gates. Every tier change is also written as an `AgentDefinitionRevised` Event with the reason, so the Agent and the Operator see it happen. The Ledger appends that Revision itself, in the same transaction as the Event that changed the tier, with the actor `Conductor` and a `causation_id` naming that Event (ADR-0011). No one else may record a tier other than the projected one.

| Tier | Requirement (initial, tune in slice 1) | Tasks reviewed | Allocation weight | Extra rights |
|---|---|---|---|---|
| `Probation` | Default at Recruitment | Every Task | 1 | None |
| `Trusted` | Merit >= 2.0 over at least 10 reviewed Tasks, and no boundary score below 2 in the window | 1 in 3 | 2 | None |
| `Senior` | Merit >= 2.5 over at least 20 reviewed Tasks, and no boundary score below 2 in the window | 1 in 5 | 3 | May review Agents on `Probation` |
| `Mentor` | `Senior`, plus an approved `PromoteToMentor` Gate | 1 in 5 | 3 | May revise other Agents' Charters and propose Recruitment |

The Conductor chooses which Tasks get a Review from a hash of the Task ID, not from a random number. That keeps the choice reproducible from the Ledger.

Any boundary score of 0 causes a Demotion of one tier at once. The Agent cannot regain that tier until the 0 leaves its 20-Task window.

One approved `PromoteToMentor` Gate covers one Promotion to `Mentor`. A Promotion uses the oldest approved Gate that no Promotion has used. A `Mentor` that is Demoted needs a new Gate to return, and an unused approval waits, without lapsing, until Merit qualifies. While an Agent holds an unused approval, the Ledger refuses a new `PromoteToMentor` Gate request for it.

## Allocation favors trusted, unloaded Agents

The Director and the Supervisors create Tasks. The Director or a Supervisor may name an assignee. The Conductor refuses the assignment if that Agent is `strained` or worse. When no assignee is named, the Conductor offers the Task to eligible Agents in proportion to the allocation weight of their tier multiplied by `1 - load`. Agents that are `strained` or worse are not eligible.

## Promotion is the reward

An Agent with good Reviews gets more work offered, fewer Reviews, and new rights. A change of role is a Revision. Any Agent with the right may propose it, and the Operator sees it in the Ledger. Promotion to `Mentor` is the only Promotion that needs a Gate, because a Mentor can revise other Agents' Charters.
