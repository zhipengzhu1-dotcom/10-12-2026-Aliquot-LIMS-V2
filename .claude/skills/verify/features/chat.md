# Chat view

The Chat view at `#/chat` shows the Lab Room `RM-lab`: every Message in seq order, newest last, each with the name of who said it, its seq and the Message it replies to, and draws again on every Event; the box at the bottom says the Operator's text in `RM-lab` through the `room-say` action, and one line says that an attached Submission Form still goes through `aliquot intake` and stage 1.

## Sub-features

- `chat-list` draws `ol.chat` with one `li.message[data-seq="<seq>"]` per Message: `.said b` holds the sayer's name (an Agent's name with its id in `.said b .muted`; the Operator's is just `Operator`), a second `.muted` in `.said` holds the seq and `replying to seq <n>`, and `.body` the text, escaped.
- `chat-say` is `form#chat-say[data-action="room-say"]` with the textarea `#chat-body`; its fixed body is `{"room_id":"RM-lab"}`.
- `chat-redraw` draws a Message another client says without a reload, from the Event stream.
- `chat-note` is the `.note` line about `aliquot intake`.
- `chat-empty` is `p.empty` when `RM-lab` has no Message, and also when `RM-lab` is not open; the box is drawn either way.

## How to get to it (user POV)

- Choose `Chat` in the navigation, or go to `#/chat`.
- `RM-lab` exists only after `room seed`; the baseline seeds it with one Message by Odile.

## Driving it with drive.sh and browser.mjs

Preconditions:

- The baseline of [README.md](./README.md): `RM-lab` holds Odile's Message and nothing else.

- **Whole drive.** Run `scripts/drive.sh "$RUN" chat`.
- **Say through the box.** `<base>` is the Ledger head before the drive (`sqlite3 "$RUN/home/ledger.sqlite" 'select max(seq) from events'`). `scripts/browser.mjs "$RUN" chat/ui goto '#/chat' mark wait '#chat-say' text 'li.message .said b' 'Odile' text '.note' 'aliquot intake' fill '#chat-body' '<report>' click '#chat-say button' text '#answer' 'Appended MessageSent at seq <base+1>' text 'li.message[data-seq="<base+1>"] .body' '<report>' text 'li.message[data-seq="<base+1>"] .said b' 'Operator'`.
- **Redraw from another client.** Continue the same browser run with `outside room-say '{"room_id":"RM-lab","body":"verify: a second client says this"}' wait 'li.message[data-seq="<base+2>"]' wait 'ol.chat > li:last-child[data-seq="<base+2>"]' same-page`. The last wait proves newest last on the screen, not only in `/api/chat`.
- **Proof.** `scripts/api.sh "$RUN" get chat` lists Odile's Message, then the two Operator Messages, in seq order; the Ledger holds exactly two new `MessageSent` rows by `{"tag":"Operator"}` in `RM-lab`.

## Gotchas

- The verify launch runs `serve --no-schedule`, so a report of received Samples starts no Turn here: the Director's Task, `parse_message` and stages 2 and 3 are proved by `conductor/src/tools/receiving.test.ts` on the scripted model, and by hand with `turn run` and `ALIQUOT_SCRIPTED_MODEL` once `serve` is stopped. The baseline registers only the stage Scripts `workflow run` uses: register `parse_message`, `log_receipt` and `create_work_order` with `sandbox register` first, as README.md's Chat section shows. Never run `turn run` without `ALIQUOT_SCRIPTED_MODEL`: it then makes a live call on the Operator's subscription.
- Drive Chat once per run. A second drive takes the Operator's Message for Odile's baseline greeting and fails; launch a fresh run.
- Saying in a Room that is not open is refused with 409 `RM-lab is not an open Room`; the view still draws the box.
- Every action is the Operator's, so a drive cannot say a Message as an Agent while `serve` runs. An Agent's Message has to be in the home before `serve` starts, as the baseline's `room say RM-lab --as A-odile` is.
- The Chat view has no `load`: the shell fetches `/api/chat` again on every Event, and the redraw keeps the text typed in `#chat-body`.
