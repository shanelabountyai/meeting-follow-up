# Demo script: Meeting Follow-Up (N7)

**6 minutes.** The story: a transcript lands in Drive; a minute or two later there is a note on the right HubSpot company and a follow-up email sitting in Gmail Drafts, addressed only to the people from the meeting. Nothing is sent. When the workflow is unsure which company it is, it says so and waits for a person.

Demo firm: Tallgrass Advisory (fictional). Every company, person and address is invented (`.example` domains). This script follows PRD §5; it has **not yet been run live** (see `docs/ACCEPTANCE.md`).

## Before the audience arrives (about 5 minutes, not part of the 6)

1. n8n running with `NODE_FUNCTION_ALLOW_BUILTIN=crypto,zlib` (`docs/SETUP.md` step 1); Google credentials reconnected (Testing-mode tokens lapse every 7 days).
2. HubSpot demo portal holds the `fixtures/hubspot-seed.json` records. Bluewater Freight has **no notes** (delete earlier N7 notes if a previous demo left one).
3. `Meetings/Inbox`, `Processed`, `Needs-Review` are empty; the `processed` ledger tab has only its header row.
4. Gmail Drafts has no `Follow-up:` drafts.
5. Have three files ready on your desktop: `fixtures/transcripts/F01-bluewater-fleet-reporting.txt`, `fixtures/transcripts/F04-two-companies-intro.txt`, and a file `F04-two-companies-intro.match.json` containing `{"companyId": "<HubSpot id of Cedar Ridge Software>"}`.
6. Open tabs: Drive `Meetings`, the HubSpot company Bluewater Freight, the HubSpot company Cedar Ridge Software, Gmail Drafts, the n8n workflow, the ledger sheet.

## The walkthrough

**1. The starting state (0:00 to 0:45).** Show `Meetings/Inbox` empty, Bluewater Freight in HubSpot with no notes, and Gmail Drafts with nothing from N7. Say: "Every meeting tool can save a transcript to Drive. That is the only integration."

**2. Drop a transcript (0:45 to 1:45).** Drag `F01-bluewater-fleet-reporting.txt` into `Meetings/Inbox`. In n8n, click *Test workflow* (the schedule stays off for demos). Show the execution moving through Plan, Normalise, Model call, Validate, the HubSpot searches, Create note, Create draft. Say: "One model call returns a fixed JSON shape. Code then checks that every action item quotes the transcript word for word before anything is written."

**3. The HubSpot note (1:45 to 2:45).** Open Bluewater Freight, refresh. Show the note: the summary, the decision, the four action items with owners and due dates, "Attendees not in CRM: Ines Varga", the link back to the transcript, and the footer `Drafted by N7 · review before relying on it`. Say: "This is the only thing it writes to the CRM. No tasks, no stage changes, no new contacts."

**4. The draft (2:45 to 3:30).** Open Gmail Drafts. The draft is addressed to Tomas Okafor and Ines Varga only (not to us), subject `Follow-up: Bluewater Freight - fleet reporting kickoff — 2026-10-06`, with the action items they own listed at the end. Say: "It is a draft. A person reads it and presses Send, or doesn't. There is no send step in the workflow at all."

**5. When it isn't sure (3:30 to 5:00).** Drop `F04-two-companies-intro.txt` and run. It names two companies and has no email addresses, so the workflow will not guess. Show the file in `Meetings/Needs-Review` next to `F04-two-companies-intro.review.json`: reason `unmatched`, its candidates (two in this fixture: Cedar Ridge Software and Ironwood Manufacturing; PRD §5 says three, see DECISIONS D-26) and the summary already written. Now resolve it: put `F04-two-companies-intro.match.json` in `Inbox`, move the transcript back to `Inbox`, run again. Open Cedar Ridge Software: the note is there. Say: "A wrong note on the wrong company is the failure that costs trust. Unmatched is a safe outcome, and fixing it is one small file."

**6. Run it twice (5:00 to 6:00).** Move `F01-bluewater-fleet-reporting.txt` from `Processed` back to `Inbox` (or upload the same file again) and run. Bluewater Freight still has **one** note (updated, same id) and Gmail still has **one** draft. Show the ledger sheet: one row per transcript with ids, status, model calls, tokens, cost (empty until prices are set in config), runtime and prompt version. No transcript text. Say: "Retries and re-runs are normal. Duplicates in a CRM are not."

## If something goes wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| Plan fails "Ledger read failed" | the `processed` tab is missing or misnamed | create it (SETUP step 2) |
| File sits in Inbox, ledger says `waiting / daily_cap` | 50 model calls already today (UTC) | raise `dailyCallCap` in `config` or wait |
| File in Needs-Review with `schema` | the model's JSON broke the contract | read `rawModelOutput` in the `.review.json`; if it recurs, fix the prompt and bump its version |
| Normalise fails on a `.docx` | n8n started without `NODE_FUNCTION_ALLOW_BUILTIN=crypto,zlib` | restart n8n with it |
| A Google node says "reconnect" | Testing-mode OAuth lapsed | reconnect the credential |
