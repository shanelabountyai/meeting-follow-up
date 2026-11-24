# Eval

PRD kickoff step 4 asks for the fixture scores here. **No live model has been run yet.** What follows is the offline run, and what it does and does not show.

## Offline run, 2026-11-24 (recorded stand-ins)

Command: `npm run eval` (also run in CI). Each fixture goes through the same functions the workflow's Code nodes run, with in-memory HubSpot, Gmail, Drive and sheet fakes. The model is replaced by **hand-written responses** in `fixtures/recorded/`. Three of them were written imperfect on purpose (F02 lists a wish as an action item, F03 misses an item, F06's merge step paraphrases a quote that the checks then drop) so the scoring is exercised in both directions.

| Fixture | Outcome | Match rule | Company | Items expected | Items kept | Correct | Recall | Precision | Model calls | Notes | Drafts |
|---|---|---|---|---|---|---|---|---|---|---|---|
| F01 | done | domain | correct | 4 | 4 | 4 | 1.00 | 1.00 | 1 | 1 | 1 |
| F02 | done | deal | correct | 2 | 3 | 2 | 1.00 | 0.67 | 1 | 1 | 1 |
| F03 | done | name | correct | 3 | 2 | 2 | 0.67 | 1.00 | 1 | 1 | 0 |
| F04 | review (unmatched) | none | correct_review | 2 | 2 | 2 | 1.00 | 1.00 | 1 | 0 | 0 |
| F05 | done | domain | correct | 3 | 3 | 3 | 1.00 | 1.00 | 1 | 1 | 1 |
| F06 | done | domain | correct | 5 | 4 | 4 | 0.80 | 1.00 | 3 | 1 | 1 |
| F07 | done | domain | correct | 4 | 4 | 4 | 1.00 | 1.00 | 1 | 1 | 1 |
| F08 | done | domain | correct | 2 | 2 | 2 | 1.00 | 1.00 | 1 | 1 | 1 |

Set: recall 0.92 (23/25), precision 0.96 (23/24), wrong company 0, sends 0. F03 has no draft because its transcript has no attendee addresses (by design); F04 has none because it is unmatched.

**What this shows:** given a response like these, the workflow logic does what PRD §2 to §4 say: the right company or Needs-Review (never a wrong company), quotes verified, owners checked, recipients only from the transcript header, one note and one draft, no sends, idempotent re-runs, chunking with map and reduce. Six failure variants (`fixtures/recorded/variants/`) cover schema failure, invented quotes, low confidence, a placeholder in the follow-up, and a model that obeyed F08's injected instruction (payment link in the body; injected address added as an attendee). Further injection paths (a pasted `Attendees:` line in the body, links in the title or action items, bare domains) are covered by unit and fixture tests rather than variants.

**What this does not show:** how well the real model extracts. The recall and precision above are properties of hand-written stand-ins and must not be quoted as model accuracy. The PRD's acceptance bar (recall ≥ 0.85, precision ≥ 0.9) is unmeasured against a model.

## Runtime and cost

- Runtime per one-hour transcript: **target under 90 seconds, not measured.**
- Model cost per run: **target under $0.10, not measured.** The ledger computes it from token usage once `priceInputPerMTokUsd` and `priceOutputPerMTokUsd` are set in `config` (D-21). The `usage` numbers inside `fixtures/recorded/` are characters/4 estimates so the logging has numbers to carry; they are not measurements.

## Live eval: to do (NEXT.md)

1. Import, map credentials, load the HubSpot seed (`docs/SETUP.md`).
2. Drop all eight transcripts in `Meetings/Inbox`, run manually (the workflow chains file to file).
3. Score each run's note against `fixtures/expected/*.expected.json` (action items by owner and quote; company correct or Needs-Review). A small script reading the notes back is the next build item.
4. Record recall, precision, wrong-company count, runtime and cost here with the date and prompt version. If the bar is missed, change `prompts/extract.md` and bump its version before anything else (PRD kickoff step 4).
