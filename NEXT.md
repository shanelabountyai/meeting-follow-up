# Next

**Open: Shane reviews the draft PR (`kickoff` → `main`), confirms the decisions marked confirm in `docs/DECISIONS.md`, then does the live steps below.** Do not merge before that review.

## 2026-11-24 — kickoff build (unattended run)

### Built (offline, on branch `kickoff`)

- `workflow.json`: the full n8n workflow per PRD §1 (schedule + manual trigger, claim into `Processing`, download, normalise incl. `.vtt`/`.docx`/Google Docs, ledger check, spend gate, one model call or map/reduce over 60,000 characters, schema validation, PRD §3 checks, HubSpot matching per §2, note create/update, Gmail draft create/update, ledger row, sidecar, move, self-chain to the next file, error trigger with `errors` tab and optional webhook). Generated from `src/` by `npm run build`; ships inactive.
- `prompts/`: `extract.md` (extract-v0.1), `extract.schema.json`, `reduce.md` (reduce-v0.1), one worked example.
- `fixtures/`: 8 synthetic transcripts (20 to 60 minutes plus one 90-minute), hand-written answer keys, recorded model stand-ins, 6 failure variants, HubSpot seed.
- Tests: 100 passing (`npm run gate`), including an offline run of `workflow.json` itself (`test/n8n-sim.js`). CI: GitHub Actions `gate`.
- Docs: `README.md`, `docs/SETUP.md`, `docs/DEMO.md`, `docs/EVAL.md`, `docs/ACCEPTANCE.md`, `docs/DECISIONS.md` (D-1 to D-36), PRD snapshot.
- An independent review of the diff found 6 must-fix issues (body-line injection into recipients and rule 1, links via title/action items, overlapping runs, ledger written last, download failure blocking the queue, docs over-claiming); all fixed with tests. The rest are listed in the PR.

### Shane's hand steps, in order

1. **Read the PR and answer "Decisions for Shane to confirm"** (rows marked confirm in `docs/DECISIONS.md`), especially D-6 (model id string), D-23 (four credentials), D-32 (the extra `Processing` folder).
2. **Import `workflow.json` into your n8n**, started with `NODE_FUNCTION_ALLOW_BUILTIN=crypto,zlib` (`docs/SETUP.md` steps 1 and 4).
3. **Create and map the four credentials:** `google-drive-lab`, `gmail-lab`, a new least-scope `hubspot-demo` service key (companies/deals/contacts read + notes write), `anthropic-lab`. Fill in the `config` node.
4. **Create the Drive folders and the ledger sheet** (`Meetings/Inbox`, `Processing`, `Processed`, `Needs-Review`; sheet tabs `processed` and `errors`).
5. **Load the HubSpot test records** from `fixtures/hubspot-seed.json` (9 companies, 2 deals with their company associations, 5 contacts).
6. **Run the demo** (`docs/DEMO.md`), then the live eval in `docs/EVAL.md`: all eight fixtures, score against `fixtures/expected/`, record recall, precision, runtime and cost there. If the PRD bar is missed, change the prompt and bump its version first.

### Next build items (after the live run)

- A small scorer that reads the live notes back from HubSpot and compares them with `fixtures/expected/` (EVAL step 3).
- Gmail audit for acceptance A2 on the live mailbox (drafts only).
- Wording flags for Shane (not changed): PRD §5 demo step 5 says "three candidates" while the two-company fixture yields two (D-26).
