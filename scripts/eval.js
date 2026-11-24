'use strict';
// Offline fixture scoring (PRD §5) with the recorded stand-in responses: prints a markdown table for docs/EVAL.md.
// This scores the pipeline around the model (validation, checks, matching), NOT the model: the responses in
// fixtures/recorded/ are hand-written. A live-model eval needs n8n and an API key (NEXT.md).
const fs = require('fs');
const path = require('path');
const H = require('../test/harness');
const SC = require('../src/score');
const { FIXTURES } = require('../fixtures/spec');

const rows = [];
for (const fx of FIXTURES) {
  const exp = JSON.parse(fs.readFileSync(path.join(H.ROOT, 'fixtures/expected', `${fx.id}.expected.json`), 'utf8'));
  const env = H.env([H.transcriptFile(fx)]);
  const r = H.runOnce(env, H.recordedModel([{ marker: fx.recorded.title, recorded: H.loadRecorded(fx.id) }]));
  const items = SC.scoreItems(exp.actionItems, r.s.validated.ex.actionItems);
  rows.push({ fx, exp, r, items, company: SC.companyOutcome(exp, r.s.match), env });
}
const agg = SC.aggregate(rows);
const f2 = (x) => x.toFixed(2);
console.log('| Fixture | Outcome | Match rule | Company | Items expected | Items kept | Correct | Recall | Precision | Model calls | Notes | Drafts |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const { fx, r, items, company, env } of rows) {
  console.log(`| ${fx.id} | ${r.fin.status}${r.fin.reason ? ` (${r.fin.reason})` : ''} | ${r.s.match.rule} | ${company} | ${items.expected} | ${items.predicted} | ${items.tp} | ${f2(items.expected ? items.tp / items.expected : 1)} | ${f2(items.predicted ? items.tp / items.predicted : 1)} | ${r.s.validated.calls} | ${env.hubspot.notes.size} | ${env.gmail.drafts.size} |`);
}
console.log(`\nSet: recall ${f2(agg.recall)} (${agg.totals.tp}/${agg.totals.e}), precision ${f2(agg.precision)} (${agg.totals.tp}/${agg.totals.p}), wrong company ${agg.wrongCompany}, sends 0.`);
process.exit(agg.wrongCompany === 0 && agg.recall >= 0.85 && agg.precision >= 0.9 ? 0 : 1);
