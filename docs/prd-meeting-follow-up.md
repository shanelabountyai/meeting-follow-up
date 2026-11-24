<!-- Snapshot of the PRD Claude Doc "N7 Meeting Follow-Up" (https://claude.ai/artifact/4jQyEmkGRx8SDcAYMijeJn), read 2026-11-24 at doc rev 5. The Doc is the source of truth; this copy is for offline reading and review. PRD decision ids D-01..D-06 are the PRD's; repo decisions in docs/DECISIONS.md are D-1, D-2, ... -->

# N7 Meeting Follow-Up — PRD v0.1

2026-11-04 · Shane LaBounty

N7 is an Automation-track n8n workflow: a meeting transcript dropped into a Google Drive folder becomes a summary, action items with owners and due dates, a note on the matching HubSpot company or deal, and a drafted follow-up email in Gmail. Drafts only; nothing is sent and no CRM field other than the note is changed. Demo-only against Shane's own HubSpot and Google Workspace, the same stance as N1 Speed-to-Lead and N2 CRM Hygiene.

## 0. Decisions log

| Id | Decision | Why |
| --- | --- | --- |
| D-01 | **Trigger is a Drive folder, not a calendar or meeting bot.** A `.txt`, `.md`, `.docx` or `.vtt` transcript lands in `Meetings/Inbox`; the workflow moves it to `Meetings/Processed` or `Meetings/Needs-Review`. | Every transcript tool (Google Meet, Zoom, Otter, Fathom) can export a file to Drive. No vendor API, no OAuth beyond Google and HubSpot, which N1 and N2 already use. |
| D-02 | **Drafts only.** The follow-up is a Gmail draft; the HubSpot note is the only write to the CRM. No tasks, no deal-stage change, no contact creation. | Same stance as N4 Inbox Triage. A demo that sends email is a demo nobody runs twice. |
| D-03 | **One model call, structured output, validated against a JSON schema** before anything is written. A failed validation sends the file to `Needs-Review` with the raw output attached. | The extraction is the whole feature; a schema makes it testable and keeps the model from writing free text into the CRM. |
| D-04 | **Matching to HubSpot is deterministic first, model second, person last.** Attendee email domains → company; a deal name quoted in the transcript → deal; otherwise the summary is written to `Needs-Review` with the top three candidate companies for a human to pick. | A wrong CRM note on the wrong company is the failure that costs trust. Unmatched is a safe outcome. |
| D-05 | **Reusable: the workflow takes one `config` node** (folder ids, HubSpot owner, from-address, model, cap) and nothing else is account-specific. Exported as JSON to the `meeting-follow-up` repo with the credential names stripped, like `speed-to-lead` and `crm-hygiene`. | The Automation track is a library of client-ready workflows for the Google + HubSpot stack. |
| D-06 | **Idempotent per file.** A transcript's Drive file id is the key: a re-run finds the existing note and draft and updates them instead of duplicating. | n8n retries and manual re-runs are normal; duplicates in a CRM are not. |

## 1. The workflow, step by step

1. **Trigger:** Drive *Watch folder* on `Meetings/Inbox`, polling every 5 minutes (n8n self-hosted has no push from Drive without a public URL).
2. **Fetch and normalise:** download the file; `.docx` through n8n's extract node, `.vtt` stripped of timestamps and speaker tags kept as `Name:` prefixes; everything to plain UTF-8 text. Over 60,000 characters → chunk by speaker turn and summarise chunks first (map), then the summaries (reduce).
3. **Idempotency check:** look up the file id in a small `processed` sheet (Google Sheets, one row per file: file id, HubSpot object id, note id, draft id, status). Found → update path; not found → create path.
4. **Extract:** one model call with the schema in §3; validate; on failure go to step 8 with reason `schema`.
5. **Match:** §2. On no match go to step 8 with reason `unmatched` and the candidates.
6. **Write the CRM note:** a HubSpot *Note* engagement associated to the matched company (and deal when found): summary, decisions, action items as a checklist with owner and due date, the Drive link to the transcript, and a footer `Drafted by N7 · review before relying on it`. The note's body is Markdown rendered to HubSpot's HTML subset.
7. **Draft the follow-up email:** Gmail draft, from the configured address, to the external attendees found in the transcript (never to anyone not named), subject `Follow-up: <meeting title> — <date>`, body from the `followUp` field, with the action items the recipients own. Saved as a draft, not sent.
8. **File and record:** move the transcript to `Processed` (or `Needs-Review` with a `.review.json` sibling holding the reason, the raw model output and the candidates); append or update the sheet row; post one line to a Slack or email digest if configured.

**Outputs per meeting:** one HubSpot note, one Gmail draft, one moved file, one sheet row. Nothing else.

**Runtime target:** under 90 seconds per transcript of a one-hour meeting; under $0.10 in model cost at current prices (checked in §4).

## 2. Matching the meeting to HubSpot (D-04)

In order; the first rule that yields exactly one company wins.

| Rule | Source | Result |
| --- | --- | --- |
| 1. Attendee email domains | emails in the transcript header or `Attendees:` line, minus the configured own domains | HubSpot company search by `domain`; one hit → match |
| 2. Deal name quoted | the model's `dealReference` field (§3), only if it is a verbatim quote from the transcript | HubSpot deal search by name; one hit → match the deal and its company |
| 3. Company name said aloud | the model's `companyMentions` list, verbatim quotes | HubSpot company search by name; exactly one hit across all mentions → match; several → candidates |
| 4. None | — | `Needs-Review` with up to three candidates from rule 3 and the summary already written, so the human only picks |

A match is never made on a fuzzy or model-inferred name alone. Rules 2 and 3 use only strings the model copied from the transcript, and the validator rejects a `dealReference` or mention that does not appear in the text.

When a person resolves a `Needs-Review` file by moving it back to `Inbox` with a `.match.json` naming the company id, the workflow takes that id and skips the rules. This is the only manual override and it is logged in the sheet row.

## 3. Extraction contract (D-03)

The model returns this object and nothing else. The n8n *Structured Output* parser validates it; any extra key, missing required key or wrong type is a `schema` failure.

```json
{
  "title": "string, ≤ 80 chars",
  "meetingDate": "YYYY-MM-DD or null",
  "attendees": [{ "name": "string", "email": "string|null", "external": true }],
  "summary": "string, 3–6 sentences, past tense, no adjectives of quality",
  "decisions": ["string, one decision each, verbatim-anchored"],
  "actionItems": [{ "owner": "attendee name", "task": "string", "due": "YYYY-MM-DD|null", "quote": "the transcript words it comes from" }],
  "openQuestions": ["string"],
  "companyMentions": ["verbatim string"],
  "dealReference": "verbatim string|null",
  "followUp": { "subject": "string", "body": "string, ≤ 180 words, plain text, no placeholders" },
  "confidence": { "summary": 0.0, "actionItems": 0.0 }
}
```

**Checks after validation** (a Code node, no model):

- Every `actionItems[].quote`, `companyMentions[]` and `dealReference` must occur in the transcript text (case-insensitive, whitespace-normalised). A miss drops that item and lowers `confidence.actionItems` by 0.1; three misses fail the file.
- Every `actionItems[].owner` must be an `attendees[].name`. Otherwise owner becomes `Unassigned` and the item is kept.
- `followUp.body` may not contain `[` `]` `{` `}` or the words `TBD`, `insert`, `placeholder`.
- `confidence.summary` below 0.6 routes the file to `Needs-Review` even when everything else passed; the note is still written, marked *low confidence*.

**Prompting rule:** the system prompt forbids inventing attendees, dates or commitments and requires a `quote` for every action item. The prompt is a file in the repo (`prompts/extract.md`), versioned; the version string is written into the sheet row so a regression can be traced to a prompt change.

## 4. Safety rails

- **Drafts only** (D-02): the Gmail node is *Create draft*; a `send` node does not exist in the workflow, so a misconfiguration cannot send. Recipients are only attendees whose email appears in the transcript.
- **One CRM write:** a Note engagement. The HubSpot credential used by the workflow has a scope set of `crm.objects.companies.read`, `crm.objects.deals.read`, `crm.objects.contacts.read`, `crm.objects.notes.write` and nothing else, so a bug cannot change a deal stage.
- **PII:** the transcript never leaves Drive except to the model call; the sheet row holds ids and a status, not text. The `.review.json` sidecar does hold the raw model output and lives in the same Drive folder with the same sharing as the transcript.
- **Spend:** the config node carries a per-day cap on model calls (default 50) and a per-file token ceiling; over either, files wait in `Inbox` and the digest says so. Cost per run is logged from the response usage, the pattern the foundation's AI spend guard formalises.
- **Idempotency** (D-06): the sheet is the ledger. A row with `status = done` and the same file id means update the existing note and draft by id; a row with `status = failed` means retry; no row means create.
- **Failure is a folder, not a log line:** every non-success ends in `Needs-Review` with a reason, so a person can see the backlog without opening n8n.

## 5. Test data, demo and acceptance

**Test data** (`fixtures/`, synthetic, written for this): eight transcripts of 20–60 minutes across the demo HubSpot companies loaded for N1 and N2, including one with no attendee emails (forces rule 3), one that names two companies (forces candidates), one `.vtt` with speaker tags, one 90-minute transcript (forces chunking), and one with an action item that has no owner. Each has an expected-output JSON written by hand, so extraction is scored, not eyeballed: action-item recall and precision per fixture, matched company correct or `Needs-Review`.

**Demo script** (`docs/DEMO.md`, 6 minutes)

1. Show `Meetings/Inbox` empty, the HubSpot company with no notes, the Gmail drafts folder.
2. Drop a transcript in; show the n8n execution running.
3. Open the HubSpot company: the note, with decisions and owned action items and the transcript link.
4. Open Gmail drafts: the follow-up, addressed only to the external attendees.
5. Drop the two-company transcript; show it land in `Needs-Review` with three candidates; move it back with a `.match.json`; show the note appear.
6. Re-drop the first transcript; show the note updated, not duplicated, and the sheet row.

**Acceptance**

- All eight fixtures: company matched correctly or routed to `Needs-Review`, never a wrong company. Action-item recall ≥ 0.85 and precision ≥ 0.9 across the set.
- Zero sends: the Gmail audit shows drafts only after the full fixture run.
- A re-run of the whole set creates no duplicate notes or drafts.
- The exported workflow JSON imports into a fresh n8n with only the config node and three credentials to fill.

## 6. Open decisions (defaults taken) and kickoff

1. **Model.** Default: Claude Sonnet 5.5 through the Anthropic node, for cost; Opus only if the fixture scores miss the acceptance bar.
2. **Digest channel.** Default: none in v0.1; a daily email summary is one node to add.
3. **Contact creation for unknown attendees.** Default: no (D-02). Listed in the note as *not in CRM* for a human.
4. **Which Drive.** Default: the Lab Intelligence Workspace Drive, shared folder `Meetings`, matching where N1 and N2 run.
5. **Transcript tools to test exports from.** Default: Google Meet and Zoom exports; others are file formats, not integrations.

**Kickoff** (new repo `shanelabountyai/meeting-follow-up`, public, same layout as `crm-hygiene`: `workflow.json`, `prompts/`, `fixtures/`, `docs/DEMO.md`, `README.md`):

```text
Build N7 Meeting Follow-Up as an n8n workflow against the self-hosted n8n and the demo HubSpot account used by Speed-to-Lead and CRM Hygiene. Read prd-meeting-follow-up.md first; its decisions D-01 to D-06 are fixed.

1. Write fixtures/ first: eight synthetic transcripts as specified in PRD §5, each with expected.json. No real names, companies or emails.
2. Write prompts/extract.md to the contract in PRD §3, versioned v0.1.
3. Build the workflow in n8n to PRD §1, with the config node as the only account-specific node. Credential names: google-drive-lab, gmail-lab, hubspot-demo.
4. Run the fixtures; record scores in docs/EVAL.md. If acceptance in §5 fails, change the prompt (bump the version) before anything else.
5. Export workflow.json with credentials stripped; write README.md (import steps, config fields, the three credentials and their minimum scopes) and docs/DEMO.md.
6. Commit on main, push. Report the fixture scores and the per-run cost. Do not enable the trigger on a schedule; leave it manual until Shane turns it on.

Rules: the Gmail node is Create draft, never Send; the HubSpot credential has read scopes plus notes.write only; nothing from a transcript is written to the sheet except ids and status.
```
