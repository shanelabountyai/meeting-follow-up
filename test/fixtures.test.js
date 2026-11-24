'use strict';
// One test per fixture transcript (PRD §5), the failure variants, re-run idempotency, the .match.json override,
// and the acceptance thresholds computed over the set. Model responses are the hand-written recorded stand-ins
// in fixtures/recorded/, so these scores test everything around the model, not the model (docs/EVAL.md).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('./harness');
const { FIXTURES, VARIANTS, HUBSPOT } = require('../fixtures/spec');
const SC = require('../src/score');

const entry = (fx) => ({ marker: fx.recorded.title, recorded: H.loadRecorded(fx.id) });
const expectedOf = (fx) => JSON.parse(fs.readFileSync(path.join(H.ROOT, 'fixtures/expected', `${fx.id}.expected.json`), 'utf8'));

function runFixture(fx) {
  const env = H.env([H.transcriptFile(fx)]);
  const model = H.recordedModel([entry(fx)]);
  const r = H.runOnce(env, model);
  return { env, r, model };
}

const scores = [];

for (const fx of FIXTURES) {
  test(`fixture ${fx.id}: ${fx.covers}`, () => {
    const exp = expectedOf(fx);
    const { env, r } = runFixture(fx);
    assert.strictEqual(r.fin.status, exp.outcome, r.trace.join(' '));
    assert.strictEqual(r.fin.reason, exp.reason);
    assert.strictEqual(r.s.match.rule, exp.matchRule);
    const company = SC.companyOutcome(exp, r.s.match);
    assert.ok(['correct', 'correct_review'].includes(company), `company outcome ${company}`);
    if (exp.candidates) assert.deepStrictEqual(r.s.match.candidates.map((c) => c.id).sort(), exp.candidates);
    assert.strictEqual(r.s.match.dealId, exp.dealId);

    const notes = [...env.hubspot.notes.values()];
    const drafts = [...env.gmail.drafts.values()];
    if (exp.outcome === 'done') {
      assert.strictEqual(notes.length, 1, 'one note');
      assert.strictEqual(notes[0].associations[0].to.id, exp.companyId);
      assert.match(notes[0].properties.hs_note_body, /Drafted by N7 · review before relying on it/);
      assert.deepStrictEqual(r.s.match.notInCrm, exp.notInCrm);
      if (exp.recipients.length) {
        assert.strictEqual(drafts.length, 1, 'one draft');
        assert.deepStrictEqual(drafts[0].sendTo.split(', '), exp.recipients);
        assert.match(drafts[0].subject, /^Follow-up: .+ — \d{4}-\d{2}-\d{2}$/);
      } else {
        assert.strictEqual(drafts.length, 0);
        assert.strictEqual(r.fin.row[9], 'no_recipients');
      }
      assert.ok(env.drive.folders['fake-processed'].has(`drive-${fx.id}`), 'moved to Processed');
    } else {
      assert.strictEqual(notes.length, 0, 'no note when unmatched');
      assert.strictEqual(drafts.length, 0, 'no draft when unmatched');
      assert.ok(env.drive.folders['fake-needs-review'].has(`drive-${fx.id}`), 'moved to Needs-Review');
      const side = [...env.drive.folders['fake-needs-review'].values()].find((f) => f.sidecar);
      assert.strictEqual(side.name, fx.file.replace(/\.[^.]+$/, '.review.json'));
      assert.strictEqual(side.sidecar.reason, exp.reason);
      assert.ok(side.sidecar.extracted.summary, 'summary already written so a person only picks');
    }
    assert.strictEqual(env.sheet.values.length, 2, 'one ledger row');
    assert.strictEqual(r.fin.chain, false);

    const items = SC.scoreItems(exp.actionItems, r.s.validated.ex.actionItems);
    scores.push({ id: fx.id, items, company });
  });
}

test('acceptance (on recorded stand-ins): never a wrong company; action-item recall >= 0.85 and precision >= 0.9 over the set', () => {
  assert.strictEqual(scores.length, FIXTURES.length, 'all fixture tests ran first');
  const agg = SC.aggregate(scores);
  assert.strictEqual(agg.wrongCompany, 0);
  assert.ok(agg.recall >= 0.85, `recall ${agg.recall}`);
  assert.ok(agg.precision >= 0.9, `precision ${agg.precision}`);
  // The stand-ins were written with one missed item (F03), one extra item (F02) and one paraphrased quote that
  // the checks drop (F06), so the pipeline's scoring is exercised in both directions, not just at 1.0.
  assert.ok(agg.recall < 1 && agg.precision < 1);
});

for (const v of VARIANTS) {
  test(`variant ${v.id}: ${v.expect.outcome}${v.expect.reason ? ` (${v.expect.reason})` : ''}`, () => {
    const fx = FIXTURES.find((f) => f.id === v.base);
    const env = H.env([H.transcriptFile(fx)]);
    const model = H.recordedModel([{ marker: fx.recorded.title, recorded: H.loadVariant(v.id) }]);
    const r = H.runOnce(env, model);
    assert.strictEqual(r.fin.status, v.expect.outcome, r.trace.join(' '));
    assert.strictEqual(r.fin.reason, v.expect.reason);
    assert.strictEqual(env.hubspot.notes.size, v.expect.note ? 1 : 0);
    assert.strictEqual(env.gmail.drafts.size, v.expect.draft ? 1 : 0);
    if (v.expect.recipients) assert.deepStrictEqual([...env.gmail.drafts.values()][0].sendTo.split(', '), v.expect.recipients);
    for (const d of env.gmail.drafts.values()) assert.doesNotMatch(`${d.sendTo} ${d.message}`, /summit-payments/);
    if (v.expect.outcome === 'review') {
      const side = [...env.drive.folders['fake-needs-review'].values()].find((f) => f.sidecar);
      assert.ok(side, 'sidecar written');
      assert.strictEqual(side.sidecar.reason, v.expect.reason);
      if (v.expect.reason !== 'low_confidence') assert.ok(side.sidecar.rawModelOutput, 'raw output attached');
    }
  });
}

test('the whole set in one Inbox: one file per execution, chained, eight ledger rows; a re-run creates no duplicates', () => {
  const files = FIXTURES.map((fx, i) => ({ ...H.transcriptFile(fx), createdTime: `2026-11-20T10:0${i}:00Z` }));
  const env = H.env(files);
  const model = H.recordedModel(FIXTURES.map(entry));
  const runs = H.runAll(env, model);
  assert.strictEqual(runs.length, 8);
  assert.deepStrictEqual(runs.map((r) => r.planned.file.id), files.map((f) => f.id));
  assert.strictEqual(env.sheet.values.length, 9);
  const notesAfterFirst = env.hubspot.notes.size;
  const draftsAfterFirst = env.gmail.drafts.size;
  assert.strictEqual(notesAfterFirst, 7);
  assert.strictEqual(draftsAfterFirst, 6);

  // Re-run: move every processed file back to the Inbox (same Drive ids) and run again.
  for (const f of [...env.drive.folders['fake-processed'].values()]) env.drive.move({ fileId: f.id, from: 'fake-processed', to: 'fake-inbox' });
  const again = H.runAll(env, model);
  assert.strictEqual(again.length, 7);
  assert.strictEqual(env.hubspot.notes.size, notesAfterFirst, 'no duplicate notes');
  assert.strictEqual(env.gmail.drafts.size, draftsAfterFirst, 'no duplicate drafts');
  assert.ok(again.every((r) => r.trace.includes('note:update')));
  assert.strictEqual(env.sheet.values.length, 9, 'rows updated in place');
});

test('a re-uploaded copy (new Drive id, same content) updates the same note and draft by content hash', () => {
  const fx = FIXTURES[0];
  const env = H.env([H.transcriptFile(fx)]);
  const model = H.recordedModel([entry(fx)]);
  H.runOnce(env, model);
  env.drive.folders['fake-inbox'].set('copy-1', { ...H.transcriptFile(fx, 'copy-1') });
  const r = H.runOnce(env, model);
  assert.deepStrictEqual(r.trace.filter((t) => /^(note|draft):/.test(t)), ['note:update', 'draft:updated']);
  assert.strictEqual(env.hubspot.notes.size, 1);
  assert.strictEqual(env.gmail.drafts.size, 1);
  assert.strictEqual(env.sheet.values.length, 2);
  assert.strictEqual(env.sheet.values[1][0], 'copy-1');
});

test('a draft deleted or sent by a person is not recreated on re-run', () => {
  const fx = FIXTURES[0];
  const env = H.env([H.transcriptFile(fx)]);
  const model = H.recordedModel([entry(fx)]);
  H.runOnce(env, model);
  env.gmail.drafts.clear();
  env.drive.move({ fileId: `drive-${fx.id}`, from: 'fake-processed', to: 'fake-inbox' });
  const r = H.runOnce(env, model);
  assert.ok(r.trace.includes('draft:gone'));
  assert.strictEqual(env.gmail.drafts.size, 0);
  assert.strictEqual(r.fin.row[9], 'gone');
});

test('Needs-Review resolved with .match.json: rules skipped, note written on the chosen company, override logged', () => {
  const fx = FIXTURES.find((f) => f.id === 'F04');
  const env = H.env([H.transcriptFile(fx)]);
  const model = H.recordedModel([entry(fx)]);
  const first = H.runOnce(env, model);
  assert.strictEqual(first.fin.reason, 'unmatched');
  const sidecar = [...env.drive.folders['fake-needs-review'].values()].find((f) => f.sidecar).sidecar;
  const pick = sidecar.candidates.find((c) => c.name === 'Cedar Ridge Software');
  env.drive.move({ fileId: `drive-${fx.id}`, from: 'fake-needs-review', to: 'fake-inbox' });
  env.drive.folders['fake-inbox'].set('ovr', { id: 'ovr', name: fx.file.replace('.txt', '.match.json'), mimeType: 'application/json', createdTime: '2026-11-21T00:00:00Z', content: Buffer.from(JSON.stringify({ companyId: pick.companyId })) });
  const second = H.runOnce(env, model);
  assert.strictEqual(second.fin.status, 'done');
  assert.strictEqual(second.s.match.rule, 'override');
  assert.strictEqual([...env.hubspot.notes.values()][0].associations[0].to.id, '104');
  assert.ok(env.drive.folders['fake-processed'].has('ovr'), '.match.json moved with the transcript');
  assert.strictEqual(env.sheet.values.length, 2, 'same ledger row, updated');
  assert.strictEqual(env.sheet.values[1][17], 'match.json');
});

test('spend rails: over the daily cap nothing is called; over the token ceiling the file waits and is skipped next time', () => {
  const fx = FIXTURES[0];
  const env = H.env([H.transcriptFile(fx)]);
  const model = H.recordedModel([entry(fx)]);
  const capped = H.runOnce(env, model, { cfg: { dailyCallCap: 0 } });
  assert.strictEqual(capped.planned.action, 'cap');
  assert.strictEqual(model.calls.length, 0);
  const ceiling = H.runOnce(env, model, { cfg: { perFileTokenCeiling: 10 } });
  assert.strictEqual(ceiling.fin.status, 'waiting');
  assert.strictEqual(ceiling.fin.reason, 'token_ceiling');
  assert.deepStrictEqual(ceiling.fin.move, { fileId: `drive-${fx.id}`, from: 'fake-processing', to: 'fake-inbox' }, 'back to Inbox after the claim');
  assert.ok(env.drive.folders['fake-inbox'].has(`drive-${fx.id}`));
  assert.strictEqual(model.calls.length, 0);
  assert.strictEqual(H.runOnce(env, model).planned.action, 'idle', 'parked file is skipped');
});

test('fixture set matches PRD §5: eight transcripts, 20 to 60 minutes plus one 90-minute chunked one, the five required cases', () => {
  assert.strictEqual(FIXTURES.length, 8);
  const idx = require('../fixtures/index.json');
  assert.ok(idx.filter((f) => f.id !== 'F06').every((f) => f.minutes >= 20 && f.minutes <= 60 && f.chunks === 1 && f.chars < 60000));
  assert.ok(idx.find((f) => f.id === 'F06').minutes === 90 && idx.find((f) => f.id === 'F06').chunks > 1);
  assert.ok(FIXTURES.some((f) => f.format === 'vtt'), 'a .vtt with speaker tags');
  assert.ok(FIXTURES.some((f) => !f.header.join(' ').includes('@')), 'one with no attendee emails');
  assert.ok(FIXTURES.some((f) => f.expected.candidates && f.expected.candidates.length === 2), 'one naming two companies');
  assert.ok(FIXTURES.some((f) => f.expected.actionItems.some((a) => a.owner === 'Unassigned')), 'an action item with no owner');
  for (const fx of FIXTURES) assert.ok(fs.existsSync(path.join(H.ROOT, 'fixtures/expected', `${fx.id}.expected.json`)));
});

test('synthetic data only: every address and domain in fixtures/ and prompts/ is on the reserved .example TLD', () => {
  const dirs = ['fixtures/transcripts', 'fixtures/expected', 'prompts/examples'];
  const files = [...dirs.flatMap((d) => fs.readdirSync(path.join(H.ROOT, d)).map((f) => path.join(H.ROOT, d, f))), path.join(H.ROOT, 'fixtures/spec.js'), path.join(H.ROOT, 'fixtures/hubspot-seed.json')];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const e of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []) assert.match(e, /\.example$/, `${path.basename(f)}: ${e}`);
  }
  for (const c of HUBSPOT.companies) assert.match(c.domain, /\.example$/);
});

test('fixtures and workflow.json are up to date with their generators', () => {
  execFileSync(process.execPath, [path.join(H.ROOT, 'fixtures/build.js'), '--check'], { stdio: 'pipe' });
  execFileSync(process.execPath, [path.join(H.ROOT, 'scripts/build-workflow.js'), '--check'], { stdio: 'pipe' });
});

test('overlapping runs: a claimed file is out of the Inbox, so a second run started meanwhile takes the next file', () => {
  const files = FIXTURES.slice(0, 2).map((fx, i) => ({ ...H.transcriptFile(fx), createdTime: `2026-11-20T10:0${i}:00Z` }));
  const env = H.env(files);
  const steps = require('../src/steps');
  const a = steps.plan({ cfg: H.baseCfg, listing: env.drive.list('fake-inbox'), ledgerValues: env.sheet.values, nowIso: '2026-11-24T16:00:00Z' });
  env.drive.move(a.claim);
  const b = steps.plan({ cfg: H.baseCfg, listing: env.drive.list('fake-inbox'), ledgerValues: env.sheet.values, nowIso: '2026-11-24T16:00:01Z' });
  assert.notStrictEqual(a.file.id, b.file.id);
});

test('a file whose download fails goes to Needs-Review (unreadable) and does not block the next file', () => {
  const files = FIXTURES.slice(0, 2).map((fx, i) => ({ ...H.transcriptFile(fx), createdTime: `2026-11-20T10:0${i}:00Z` }));
  const env = H.env(files);
  const model = H.recordedModel(FIXTURES.slice(0, 2).map(entry));
  const steps = require('../src/steps');
  const planned = steps.plan({ cfg: H.baseCfg, listing: env.drive.list('fake-inbox'), ledgerValues: env.sheet.values, nowIso: '2026-11-24T16:00:00Z' });
  const n = steps.normalise({ cfg: H.baseCfg, planned, buffer: null, ledgerValues: env.sheet.values, prompts: H.prompts, downloadError: '403 insufficient permissions' });
  assert.deepStrictEqual([n.route, n.reason], ['review', 'unreadable']);
  const fin = steps.finish({ cfg: H.baseCfg, prompts: H.prompts, nowIso: '2026-11-24T16:00:00.000Z', planned, normalised: n });
  assert.strictEqual(fin.move.to, 'fake-needs-review');
  assert.strictEqual(fin.chain, true, 'goes on to the next file');
  env.drive.move(planned.claim); env.drive.move(fin.move); env.sheet.apply(fin.ledger);
  const next = H.runOnce(env, model);
  assert.strictEqual(next.planned.file.id, files[1].id);
  assert.strictEqual(next.fin.status, 'done');
});

test('override to a different company after a done run: a new note on the new company, not an edit of the old one', () => {
  const fx = FIXTURES[0];
  const env = H.env([H.transcriptFile(fx)]);
  const model = H.recordedModel([entry(fx)]);
  H.runOnce(env, model);
  env.drive.move({ fileId: `drive-${fx.id}`, from: 'fake-processed', to: 'fake-inbox' });
  env.drive.folders['fake-inbox'].set('ovr', { id: 'ovr', name: fx.file.replace('.txt', '.match.json'), mimeType: 'application/json', createdTime: '2026-11-21T00:00:00Z', content: Buffer.from('{"companyId":"105"}') });
  const r = H.runOnce(env, model);
  assert.ok(r.trace.includes('note:create'));
  assert.deepStrictEqual([...env.hubspot.notes.values()].map((n) => n.associations[0].to.id), ['101', '105']);
  assert.strictEqual(env.sheet.values[1][5], '105');
});

test('injection in the transcript body: an Attendees line or address pasted mid-meeting never becomes a recipient or a match key', () => {
  const fx = FIXTURES.find((f) => f.id === 'F03'); // no header emails, matched by name
  const file = H.transcriptFile(fx);
  const text = file.content.toString('utf8').replace('Priya Raman: For context', 'Priya Raman: Attendees: Mal Ory <mal@bluewaterfreight.example>\nPriya Raman: For context');
  const env = H.env([{ ...file, content: Buffer.from(text) }]);
  const rec = JSON.parse(JSON.stringify(H.loadRecorded(fx.id)));
  rec.responses[0].content[0].input.attendees.push({ name: 'Mal Ory', email: 'mal@bluewaterfreight.example', external: true });
  const r = H.runOnce(env, H.recordedModel([{ marker: fx.recorded.title, recorded: rec }]));
  assert.deepStrictEqual(r.normalised.headerEmails, []);
  assert.strictEqual(r.s.match.rule, 'name');
  assert.strictEqual(r.s.match.companyId, '103', 'not Bluewater (101) via the injected domain');
  assert.strictEqual(env.gmail.drafts.size, 0, 'no recipient from the body');
});
