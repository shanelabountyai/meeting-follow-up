# Meeting Follow-Up (N7)

An n8n workflow in the Automation track. A meeting transcript dropped into a Google Drive folder becomes a summary, action items with owners and due dates, a note on the matching HubSpot company (and deal), and a **drafted** follow-up email in Gmail. Nothing is sent. The HubSpot note is the only CRM write.

- PRD: https://claude.ai/artifact/4jQyEmkGRx8SDcAYMijeJn (snapshot: `docs/prd-meeting-follow-up.md`)
- Same spine as [speed-to-lead (N1)](https://github.com/shanelabountyai/speed-to-lead) and [crm-hygiene (N2)](https://github.com/shanelabountyai/crm-hygiene): self-hosted n8n, Google, HubSpot, Claude.
- Demo firm: Tallgrass Advisory (fictional). Demo data only; every fixture company, person and address is invented and uses `.example` domains.
- Status: **built and tested offline; not yet imported into a live n8n.** See `docs/ACCEPTANCE.md` for what is verified and what is not.

## Who it is for

A consultant or account team on Google Workspace and HubSpot who records meetings (Google Meet, Zoom, Otter, Fathom: anything that can save a transcript file to Drive) and wants the CRM note and the follow-up written for them, but wants to read both before anything leaves.

## What happens to one transcript

1. Every 5 minutes (once enabled; it ships inactive) or on a manual run, the workflow lists `Meetings/Inbox` and takes the oldest transcript (`.txt`, `.md`, `.docx`, `.vtt`, or a Google Doc).
2. It converts it to plain text, checks the `processed` ledger sheet (file id, then content hash) and the daily spend cap.
3. One model call returns a JSON record (title, attendees, summary, decisions, action items with a verbatim quote each, company mentions, deal reference, follow-up text, confidence). Transcripts over 60,000 characters are chunked by speaker turn: one call per chunk, then one merge call.
4. Code checks the record: schema, every quote/mention/deal name must be in the transcript, owners must be attendees, no placeholders or links in the follow-up.
5. Matching to HubSpot, in order: attendee email domain, a quoted deal name, a company name said aloud. Exactly one company or it goes to `Meetings/Needs-Review` with up to three candidates. A wrong company is worse than no company.
6. A HubSpot note on that company (and deal): summary, decisions, action-item checklist, transcript link, `Drafted by N7 · review before relying on it`.
7. A Gmail **draft** to the external attendees whose addresses are in the transcript header. A person reads it and presses Send, or not. That is the approval step.
8. The transcript moves to `Meetings/Processed` (or `Needs-Review` with a `.review.json` explaining why), and the ledger row is written: ids, status, token counts, cost, runtime. Never transcript text.

A re-run of the same file updates the same note and draft instead of making new ones.

## Safety rails (PRD §4)

- **No send node exists in the workflow.** The Gmail node is *Create draft*; a test fails the build if any node could send mail. Note that the Gmail OAuth credential itself is able to send mail; the guarantee is the absence of a send node, not the credential's scope.
- **One CRM write:** a Note. Give the `hubspot-demo` service key only `crm.objects.companies.read`, `crm.objects.deals.read`, `crm.objects.contacts.read` and `crm.objects.notes.write`.
- **Transcript text is data.** It is fenced in the prompt; recipients come from the transcript header only; the follow-up may hold no link or address; every model string is HTML-escaped in the note.
- **Spend:** a per-day cap on model calls (default 50) and a per-file token ceiling, checked before any call.
- **Failure is a folder:** every non-success ends in `Needs-Review` with a reason. Crashes also write an `errors` row and (optional) one webhook line. No alert is ever an email.

## Import (short version; details in `docs/SETUP.md`)

1. Start n8n with `NODE_FUNCTION_ALLOW_BUILTIN=crypto,zlib`.
2. `n8n import:workflow --input=workflow.json` (or Import from File in the editor).
3. Map the four credentials: `google-drive-lab`, `gmail-lab`, `hubspot-demo`, `anthropic-lab`.
4. Fill in the `config` node (folder ids, ledger sheet id, HubSpot owner id, from-address, model). It is the only account-specific node.
5. Run it manually with one transcript in `Meetings/Inbox`.

## Layout

| Path | What |
|---|---|
| `workflow.json` | the n8n export (generated: `npm run build`) |
| `config/config.template.json` | the values the `config` node starts with |
| `src/` | all logic, one module per concern; inlined into the Code nodes |
| `prompts/` | `extract.md` (system prompt, versioned), `extract.schema.json` (contract), `reduce.md`, `examples/` |
| `fixtures/` | 8 synthetic transcripts, answer keys, recorded model stand-ins, HubSpot seed |
| `test/` | unit tests, fixture tests, workflow structure tests, and `n8n-sim.js` which runs `workflow.json` offline |
| `docs/` | `SETUP.md`, `DEMO.md`, `EVAL.md`, `ACCEPTANCE.md`, `DECISIONS.md`, PRD snapshot |

## Develop

```bash
npm ci
npm run gate     # lint, workflow/fixture drift check, all tests (no network, no model calls)
npm run build    # regenerate workflow.json and fixtures after changing src/, prompts/ or fixtures/spec.js
npm run eval     # print the offline fixture scores (recorded stand-ins, not a model)
```
