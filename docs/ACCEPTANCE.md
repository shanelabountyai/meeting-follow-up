# Acceptance checklist

Each PRD item mapped to its evidence as of 2026-11-24 (kickoff build). "Offline" means tested in this repo against fakes and hand-written model stand-ins (`npm run gate`, CI); "live" means run on Shane's n8n against the demo HubSpot, Drive and Gmail. **Nothing has been run live yet.**

## PRD §5 acceptance

| # | PRD acceptance item | Offline | Live | Evidence |
|---|---|---|---|---|
| A1 | All eight fixtures: company matched correctly or routed to Needs-Review, never a wrong company. Action-item recall ≥ 0.85 and precision ≥ 0.9 across the set. | **Partly.** Company: 8/8 correct (7 matched, F04 to Needs-Review), 0 wrong. Recall 0.92 / precision 0.96 but on hand-written stand-ins, which says nothing about the model. | not run | `test/fixtures.test.js` (one test per fixture + the set test), `docs/EVAL.md` |
| A2 | Zero sends: the Gmail audit shows drafts only after the full fixture run. | **Yes, by construction.** No node, HTTP endpoint or Code node can send (structural test); the offline runs of `workflow.json` make no call to any send path (checked from the simulator's request log). The fakes have no send function, so the fake runs alone would not prove this; the structural test does. | not run (no Gmail audit) | `test/workflow.test.js` "no node can send email" and the offline-run tests |
| A3 | A re-run of the whole set creates no duplicate notes or drafts. | **Yes.** Re-run of all eight: 7 notes and 6 drafts before and after, ledger rows updated in place; also a re-uploaded copy (new Drive id) and the exported `workflow.json` itself. | not run | `test/fixtures.test.js` re-run tests; `test/workflow.test.js` "two files chain ... re-run updates" |
| A4 | The exported workflow JSON imports into a fresh n8n with only the config node and three credentials to fill. | **No.** `config` is the only account-specific node (tested), but there are **four** credentials (D-23), and an editor import may need the error-workflow setting re-pointed (SETUP step 4.3). Import not tried. | not run | `test/workflow.test.js` "config is the only account-specific node", "credentials: four placeholders" |

Summary: offline 2 of 4 met (A2, A3), 1 partly (A1), 1 not met (A4). Live: 0 of 4 verified.

## Other PRD requirements

| PRD | Requirement | Status | Evidence |
|---|---|---|---|
| D-01, §1.1 | Drive folder trigger, `Inbox` → `Processed` / `Needs-Review`; `.txt .md .docx .vtt` | built; schedule + list instead of Drive trigger (D-10); Google Docs too (D-9); a `Processing` claim folder added (D-32) | `test/plan.test.js`, `test/normalize.test.js` (vtt, docx) |
| D-02, §4 | Drafts only; note is the only CRM write | built and tested | `test/workflow.test.js` (send rail, HubSpot rail) |
| D-03, §3 | One call, structured output validated against a schema; failure → Needs-Review with raw output | built (HTTP + forced tool, D-5); map/reduce over 60k chars (D-7) | `test/schema.test.js` (hand validator and Ajv agree), variant `F01-schema-extra-key` |
| D-04, §2 | Matching rules 1 to 4, verbatim strings only, candidates, `.match.json` override logged | built and tested | `test/match.test.js`, fixtures F01 to F05, override test |
| D-05 | One config node; exported with placeholder credentials | built | `test/workflow.test.js` |
| D-06, §4 | Idempotent per file via the sheet ledger; done → update, failed → retry, none → create | built (+ content hash D-11, claim folder against overlapping runs D-32, ledger before moves D-34) | `test/outputs.test.js` ledger tests, re-run tests |
| §1.2 | `.vtt` timestamps stripped, speakers kept; chunk by speaker turn over 60,000 chars | built | `test/normalize.test.js`, F05, F06 |
| §1.6 | Note: summary, decisions, checklist with owner and due, Drive link, footer, HTML | built | `test/outputs.test.js` note tests |
| §1.7 | Draft from the configured address to external attendees found in the transcript only; subject format; recipients' own items | built (recipients from the header block only, D-14; links refused in all draft text, D-15) | `test/outputs.test.js` draft tests, `test/normalize.test.js` body-injection tests, `test/fixtures.test.js` "injection in the transcript body", variant `F08-injection-attendee-only` |
| §1.8 | Move, `.review.json` sidecar, ledger row; digest if configured | built; no digest in v0.1 (PRD §6.2) | fixture tests |
| §3 checks | quote/mention/deal presence (−0.1 per miss, 3 fail), owner → Unassigned, placeholder words, low confidence | built | `test/checks.test.js` |
| §3 prompting rule | no invented attendees/dates/commitments; quote per item; prompt versioned in repo and written to the ledger | built | `prompts/extract.md`, `test/extract.test.js`, ledger `prompt_version` |
| §4 scopes | HubSpot key read scopes + `notes.write` only | documented; the key is Shane's to create | `docs/SETUP.md` step 3 |
| §4 PII | sheet holds ids and status only | enforced in code | `test/outputs.test.js` "rows hold ids, codes and numbers only" |
| §4 spend | daily cap (50), per-file token ceiling, cost from usage | built; prices null until set (D-21) | `test/outputs.test.js` spend, `test/fixtures.test.js` spend rails |
| §4 failure | every non-success ends in Needs-Review with a reason | built for handled failures (schema, unmatched, low confidence, download, HubSpot and Gmail errors); an unhandled crash after the claim leaves the file in `Processing` with an `errors` row (D-32) | `test/workflow.test.js` HubSpot outage, error trigger |
| §5 test data | 8 synthetic transcripts with the five named cases and hand-written expected JSON | built | `test/fixtures.test.js` "fixture set matches PRD §5" |
| §5 demo | `docs/DEMO.md`, 6 minutes | written, not rehearsed | `docs/DEMO.md` |
| §1 runtime | under 90 s per one-hour transcript; under $0.10 | **target, not measured** | `docs/EVAL.md` |

## Not verified

- Not imported into a live n8n; node parameter shapes (HTTP Request 4.2, Gmail 2.1 draft options, Execute Workflow 1.2, IF 2.2) follow n8n's export format but have not been loaded by n8n.
- Not run against live HubSpot, Drive, Sheets or Gmail; HubSpot association type ids 190/214 and the `EQ` search behaviour are from HubSpot's documented defaults, not tried.
- No model call: extraction quality, runtime and cost are unmeasured.
- `this.helpers.getBinaryDataBuffer` in the Normalise Code node and the `crypto`/`zlib` builtins depend on the n8n version and its `NODE_FUNCTION_ALLOW_BUILTIN` setting.
- The demo script has not been rehearsed.
- The claim (D-32) narrows overlapping runs to the second or two between listing the Inbox and moving the file; it does not close that window.
- The Gmail node's `fromAlias` option name for drafts is taken from n8n's Gmail node; not checked on Shane's n8n version.
