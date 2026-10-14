# Chat view

The Chat view at `#/chat` shows the Lab Room `RM-lab`: every Message in seq order, newest last, each with the name of who said it, its seq and the Message it replies to, and draws again on every Event; the box at the bottom says the Operator's text in `RM-lab` through the `room-say` action, a receipt or results said there gets the Conductor's reply from its Chain within 5 s with no reload (ADR-0020), and one line says that an attached Submission Form still goes through `aliquot intake` and stage 1.

## Sub-features

- `chat-list` draws `ol.chat` with one `li.message[data-seq="<seq>"]` per Message: `.said b` holds the sayer's name (an Agent's name with its id in `.said b .muted`; the Operator's is the person's email with `Operator` muted beside it, `verify@lab.test` in a verify run), a second `.muted` in `.said` holds the seq and `replying to seq <n>`, and `.body` the text, escaped.
- `chat-say` is `form#chat-say[data-action="room-say"]` with the textarea `#chat-body`; its fixed body is `{"room_id":"RM-lab"}`.
- `chat-redraw` draws a Message another client says without a reload, from the Event stream.
- `chat-chain` is the Conductor's reply to a receipt or results the box said: the last `li.message`, `.said b` `Conductor`, `replying to seq <n>`, its `.body` the Lab References and due date, or the Gate id and the report's two Artifact ids.
- `chat-note` is the `.note` line about `aliquot intake`.
- `chat-empty` is `p.empty` when `RM-lab` has no Message, and also when `RM-lab` is not open; the box is drawn either way.

## How to get to it (user POV)

- Choose `Chat` in the navigation, or go to `#/chat`.
- `RM-lab` exists only after `room seed`; the baseline seeds it with one Message by Odile.

## Driving it with drive.sh and browser.mjs

Preconditions:

- The baseline of [README.md](./README.md): `RM-lab` holds Odile's Message and nothing else.

- **Whole drive.** Run `scripts/drive.sh "$RUN" chat`.
- **Say the receipt through the box.** `<base>` is the Ledger head before the drive (`sqlite3 "$RUN/home/ledger.sqlite" 'select max(seq) from events'`). `scripts/browser.mjs "$RUN" chat/ui goto '#/chat' mark wait '#chat-say' text 'li.message .said b' 'Odile' text '.note' 'aliquot intake' fill '#chat-body' '<report>' click '#chat-say button' text '#answer' 'Appended MessageSent at seq <base+1>' text 'li.message[data-seq="<base+1>"] .body' '<report>' text 'li.message[data-seq="<base+1>"] .said b' 'verify@lab.test' text 'ol.chat > li:last-child .said' 'replying to seq <base+1>' text 'ol.chat > li:last-child .body' 'Logged LR-2026-0003, LR-2026-0004, LR-2026-0005 on WO-2026-0002, due ' same-page`.
- **Say the results through the box.** Continue with `fill '#chat-body' '<results>' click '#chat-say button' text 'ol.chat > li:last-child .body' 'The Report of Analysis of LR-2026-0003 waits on G-' same-page`.
- **Redraw from another client.** Continue the same browser run with `outside room-say '{"room_id":"RM-lab","body":"verify: a second client says this"}' text 'ol.chat > li:last-child .body' 'verify: a second client says this' same-page`. The last check proves newest last on the screen, not only in `/api/chat`.
- **Proof.** `scripts/api.sh "$RUN" get chat` lists, after Odile's Message, the receipt, the Conductor's reply, the results, the Conductor's reply and the second client's Message, in seq order. The drive writes `chat/reply-times.txt`, each reply's `ts` minus its Message's, and checks each is under 5000 ms; checks no `TurnStarted` since `<base>`; checks `/api/gates` holds the Conductor's open `ExternalMessage` Gate naming `LR-2026-0003`; and checks with a recursive query on `events` that every Conductor Event of the drive reaches one of the drive's Operator `MessageSent` rows through `causation_id`.

## Gotchas

- The Conductor's Chains need no Turn and no model, so they run under the launch's `serve --no-schedule`. They need the parse Scripts registered before `serve` starts, which `launch.sh` does; on a home without them the reply is `I cannot receive these yet: the Conductor stopped: S-parse_message is not registered.` The Agents' path for a Message no Chain takes is proved by `conductor/src/tools/receiving.test.ts` and `results.test.ts` on the scripted model. Never run `turn run` without `ALIQUOT_SCRIPTED_MODEL`: it then makes a live call on the Operator's subscription.
- On the launch baseline, which holds seed 1's `workflow run`, the receipt's `S-log_receipt` Run carries the latest toy LIMS database a passed Run wrote, so the receipt's three containers are `LR-2026-0003` to `LR-2026-0005` on `WO-2026-0002`, and the results Chain reports on `LR-2026-0003`. The baseline holds no Gate, so the results Chain's Gate is `G-1`.
- Two runs on 2026-10-14 measured 1091 ms from the receipt to its reply and 1685 ms from the results to theirs, with a cold container per Run.
- Drive Chat once per run. A second drive takes the Operator's Message for Odile's baseline greeting and fails; launch a fresh run.
- Saying in a Room that is not open is refused with 409 `RM-lab is not an open Room`; the view still draws the box.
- Every action is the Operator's, so a drive cannot say a Message as an Agent while `serve` runs. An Agent's Message has to be in the home before `serve` starts, as the baseline's `room say RM-lab --as A-odile` is.
- The Chat view has no `load`: the shell fetches `/api/chat` again on every Event, and the redraw keeps the text typed in `#chat-body`.
