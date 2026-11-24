# Setup: import N7 into your self-hosted n8n

One page. Runs on the same n8n as N1 and N2. Nothing here sends mail; demo data only. Never paste a key into a file in this repo: credentials live in n8n's store.

## 1. Start n8n with two builtins allowed

The Code nodes hash the transcript (`crypto`) and read `.docx` files (`zlib`).

```bash
export PATH=$HOME/.n8n-runtime/node_modules/.bin:$PATH N8N_USER_FOLDER=$HOME/.n8n-speed-to-lead
NODE_FUNCTION_ALLOW_BUILTIN=crypto,zlib n8n start
```

## 2. Drive folders and the ledger sheet

1. In the Lab Intelligence Workspace shared drive, create `Meetings/Inbox`, `Meetings/Processing`, `Meetings/Processed`, `Meetings/Needs-Review`. Copy each folder id from its URL. (`Processing` holds the file a run is working on; D-32.)
2. Create a Google Sheet `N7 ledger` with two tabs:
   - `processed`, row 1: `file_id, content_hash, status, reason, match_rule, company_id, deal_id, note_id, draft_id, draft_state, prompt_version, model, model_calls, input_tokens, output_tokens, cost_usd, runtime_s, override, processed_at` (one header per column, A to S)
   - `errors`, row 1: `time, execution_id, node, message`

## 3. Credentials (create in the editor, names exact)

| Name | n8n type | Minimum access |
|---|---|---|
| `google-drive-lab` | Google Drive OAuth2 API | Drive scope (also used for the Sheets API calls, D-12). The account must see the shared drive. |
| `gmail-lab` | Gmail OAuth2 | the mailbox that should hold the drafts. It can send; the workflow never asks it to. |
| `hubspot-demo` | HubSpot App Token | a **new** service key with only `crm.objects.companies.read`, `crm.objects.deals.read`, `crm.objects.contacts.read`, `crm.objects.notes.write`. Do not reuse N1's key (it can write contacts and tasks). |
| `anthropic-lab` | Anthropic API | an API key; reusing N1's is fine |

Google OAuth in Testing mode lapses every 7 days while n8n's UI still says "connected" (N1 lesson). Reconnect before a demo.

## 4. Import and map

```bash
n8n import:workflow --input=workflow.json     # n8n stopped; keeps the workflow id n7MeetingFollowUp
```

Or Import from File in the editor. Then open the workflow:

1. Each red credential: pick the credential from step 3 (the export carries placeholder ids `map-on-import-...`).
2. Open the **`config`** node, the only account-specific node, and replace every `REPLACE_WITH_` value:

| Field | Value |
|---|---|
| `inboxFolderId`, `processingFolderId`, `processedFolderId`, `needsReviewFolderId` | the four folder ids |
| `ledgerSheetId` | the sheet id; `ledgerTab` / `errorsTab` stay `processed` / `errors` |
| `hubspotOwnerId` | your HubSpot owner id (N1's `rules/config.json` has it) |
| `fromAddress` | the From line for drafts updated by a re-run, e.g. `Tallgrass Advisory <you@...>` |
| `ownDomains` | the host firm's email domains (attendees on these are never recipients or match keys). The fixtures use `tallgrassadvisory.example`; add your real domain for real meetings. |
| `model` | the Anthropic model id for Claude Sonnet 5.5 as your console lists it (D-6) |
| `dailyCallCap`, `perFileTokenCeiling`, `chunkChars` | 50 / 100000 / 60000 unless you want otherwise |
| `priceInputPerMTokUsd`, `priceOutputPerMTokUsd` | current USD prices per million tokens, so the ledger logs cost (left `null`, it logs tokens only) |
| `alertWebhookUrl` | optional Slack incoming-webhook URL for error lines; empty = errors tab only |

3. If the import gave the workflow a new id (editor import does), open Workflow Settings and set **Error workflow** to this workflow itself.
4. Leave the workflow **inactive**. Use *Test workflow* (manual trigger) until you decide to turn the 5-minute schedule on.

## 5. Demo data in HubSpot

Load the companies, two deals and five contacts in `fixtures/hubspot-seed.json` (names and domains; HubSpot gives them new ids). Associate deal `Member Portal Refresh` with Harborview Credit Union and `Fleet Reporting Rollout` with Bluewater Freight. All records are fictional `.example` domains.

## 6. Prove it

Drop `fixtures/transcripts/F01-bluewater-fleet-reporting.txt` in `Meetings/Inbox`, run manually, and check: one note on Bluewater Freight, one Gmail draft to the two Bluewater addresses, the file in `Processed`, one ledger row with `status = done`. Then follow `docs/DEMO.md`.
