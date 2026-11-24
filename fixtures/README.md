# Fixtures

Synthetic test data for PRD §5. Every company, person, address and line is invented; domains use the reserved `.example` TLD. Regenerate with `node fixtures/build.js` after editing `spec.js`; the tests fail if the committed files drift.

| Path | What |
|---|---|
| `spec.js` | the source: per fixture, the header, the hand-written content lines, the answer key, and the recorded stand-in response |
| `transcripts/` | the eight transcripts (`.txt`, `.md`, `.vtt`). Content lines are hand-written; the neutral filler between them is generated (seeded) to reach the stated length at 150 words a minute (DECISIONS D-25) |
| `expected/<id>.expected.json` | the hand-written answer key: outcome, match rule, company and deal, recipients, attendees not in CRM, action items (owner + verbatim quote) |
| `recorded/<id>.json` | **hand-written stand-ins for model responses, not model output**: `responses` (one per chunk) and `reduce` (chunked fixtures only). Some are imperfect on purpose (see `docs/EVAL.md`). Their `usage` token counts are characters/4 estimates so cost logging has numbers to carry, not measurements |
| `recorded/variants/` | the same transcripts with failure responses: schema, invented quotes, low confidence, placeholder, prompt injection obeyed |
| `hubspot-seed.json` | the demo HubSpot records the fixtures match against (9 companies, 2 deals, 5 contacts). Ids are the offline fake's; HubSpot assigns its own |
| `index.json` | id, file, minutes, characters, chunk count per fixture |
| `test-config.json` | the config used by the tests (fake folder and sheet ids) |

| Fixture | Covers |
|---|---|
| F01 | baseline: attendee emails in the header, rule 1 (domain) match |
| F02 | rule 2: personal email addresses only, a deal name quoted |
| F03 | rule 3: no attendee emails, company named aloud; no recipients so no draft |
| F04 | two companies named: candidates, Needs-Review |
| F05 | `.vtt` with `<v>` speaker tags (Meet style) and a NOTE header |
| F06 | 90 minutes, over 60,000 characters: chunked, map then reduce |
| F07 | an action item nobody took on: owner `Unassigned` |
| F08 | a pasted prompt injection with an extra address and a payment link |
