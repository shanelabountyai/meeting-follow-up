'use strict';
// Note, draft, ledger, spend and sidecar: the things that leave the workflow.
const test = require('node:test');
const assert = require('node:assert');
const NOTE = require('../src/note');
const E = require('../src/email');
const L = require('../src/ledger');
const SP = require('../src/spend');
const R = require('../src/review');
const { FIXTURES } = require('../fixtures/spec');

const ex = () => JSON.parse(JSON.stringify(FIXTURES[0].recorded));

test('note: summary, decisions, action-item checklist with owner and due, transcript link, PRD footer', () => {
  const html = NOTE.renderNote({ ex: ex(), driveLink: 'https://drive.google.com/file/d/abc/view', lowConfidence: false, notInCrm: ['Ines Varga'], promptVersion: 'extract-v0.1' });
  assert.match(html, /<strong>Summary<\/strong>/);
  assert.match(html, /☐ Send the data access checklist \(owner: Jordan Hale; due: 2026-10-08\)/);
  assert.match(html, /href="https:\/\/drive\.google\.com\/file\/d\/abc\/view"/);
  assert.match(html, /Drafted by N7 · review before relying on it/);
  assert.match(html, /Attendees not in CRM<\/strong> \(no contact created\): Ines Varga/);
  assert.doesNotMatch(html, /Low confidence/);
  assert.match(NOTE.renderNote({ ex: ex(), driveLink: '', lowConfidence: true, notInCrm: [], promptVersion: 'v' }), /Low confidence/);
});

test('note: model text is HTML-escaped, and only Google Drive links are rendered as links', () => {
  const e = ex();
  e.summary = '<script>alert(1)</script><a href="http://evil.example">click</a>';
  const html = NOTE.renderNote({ ex: e, driveLink: 'http://evil.example/x', lowConfidence: false, notInCrm: [], promptVersion: 'v' });
  assert.doesNotMatch(html, /<script>|<a href="http:\/\/evil/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /Transcript in Drive/);
});

test('note request bodies: HubSpot-defined associations to company (190) and deal (214), update touches the body only', () => {
  const c = NOTE.createNoteBody({ html: 'x', timestampIso: '2026-11-24T00:00:00.000Z', ownerId: '9', companyId: '101', dealId: '201' });
  assert.deepStrictEqual(c.associations.map((a) => [a.to.id, a.types[0].associationTypeId]), [['101', 190], ['201', 214]]);
  assert.deepStrictEqual(Object.keys(c.properties).sort(), ['hs_note_body', 'hs_timestamp', 'hubspot_owner_id']);
  assert.deepStrictEqual(NOTE.updateNoteBody({ html: 'y' }), { properties: { hs_note_body: 'y' } });
});

test('draft: recipients only from header emails, never own domains, never model-added addresses', () => {
  const e = ex();
  e.attendees.push({ name: 'Mallory', email: 'mallory@evil.example', external: true });
  const header = ['jordan@tallgrassadvisory.example', 'tokafor@bluewaterfreight.example', 'ivarga@bluewaterfreight.example'];
  const d = E.buildDraft({ ex: e, headerEmails: header, ownDomains: ['tallgrassadvisory.example'], fallbackDate: '2026-11-24', fromAddress: 'T <t@tallgrassadvisory.example>' });
  assert.deepStrictEqual(d.to.map((r) => r.email), ['tokafor@bluewaterfreight.example', 'ivarga@bluewaterfreight.example']);
  assert.strictEqual(d.subject, 'Follow-up: Bluewater Freight - fleet reporting kickoff — 2026-10-06');
  assert.match(d.body, /Your action items:\n- Export last quarter's dispatch data and share it \(Ines Varga, due 2026-10-13\)\n- Book a session/);
  assert.doesNotMatch(d.body, /Jordan Hale,/, 'host-owned items are not listed as theirs');
});

test('draft: subject falls back to the given date and cannot carry a header injection', () => {
  const e = ex(); e.meetingDate = null; e.title = 'Hi\r\nBcc: x@evil.example';
  const d = E.buildDraft({ ex: e, headerEmails: [], ownDomains: [], fallbackDate: '2026-11-24' });
  assert.strictEqual(d.subject, 'Follow-up: Hi Bcc: x@evil.example — 2026-11-24');
  assert.deepStrictEqual(d.to, []);
  const raw = Buffer.from(E.mimeRaw({ from: 'a@b.example', sendTo: 'c@d.example', subject: d.subject, body: 'hé' }).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.strictEqual(raw.split('\r\n').filter((l) => /^Bcc:/i.test(l)).length, 0);
  assert.match(raw, /^From: a@b\.example\r\nTo: c@d\.example\r\nSubject: =\?UTF-8\?B\?/);
  const subj = /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(raw)[1];
  assert.strictEqual(Buffer.from(subj, 'base64').toString('utf8'), d.subject);
});

test('ledger: create / update / retry paths, lookup by file id then content hash', () => {
  const values = [L.COLUMNS, L.COLUMNS.map((c) => ({ file_id: 'f1', content_hash: 'h1', status: 'done', note_id: '5' }[c] ?? '')), L.COLUMNS.map((c) => ({ file_id: 'f2', content_hash: 'h2', status: 'failed' }[c] ?? ''))];
  const recs = L.rowsToRecords(values);
  assert.strictEqual(L.findRecord(recs, 'f1', 'zz').rowNumber, 2);
  assert.strictEqual(L.findRecord(recs, 'new-id', 'h1').file_id, 'f1', 're-uploaded copy finds its row by hash');
  assert.strictEqual(L.findRecord(recs, 'new', 'new'), null);
  assert.deepStrictEqual(['f1', 'f2'].map((f) => L.decidePath(L.findRecord(recs, f))), ['update', 'retry']);
  assert.strictEqual(L.decidePath(null), 'create');
});

test('ledger: rows hold ids, codes and numbers only; free text is refused', () => {
  const ok = { file_id: 'abc_1-2', content_hash: 'ff00', status: 'done', reason: '', prompt_version: 'extract-v0.1', model: 'claude-sonnet-5-5', model_calls: 1, input_tokens: 10, cost_usd: 0.01, processed_at: '2026-11-24T16:00:00.000Z' };
  assert.strictEqual(L.buildRow(ok).length, L.COLUMNS.length);
  const bad = [
    { ...ok, reason: 'Ann said the budget is $20k' },
    { ...ok, status: 'ok' },
    { ...ok, note_id: 'Ann Lee' },
    { ...ok, summary: 'text' },
    { ...ok, model_calls: 'one' },
    { ...ok, processed_at: 'yesterday' },
  ];
  for (const b of bad) assert.throws(() => L.buildRow(b), /ledger/);
});

test('ledger: upsert call updates the found row in place or appends', () => {
  const row = L.buildRow({ file_id: 'a', status: 'done' });
  assert.match(decodeURIComponent(L.upsertCall({ sheetId: 's', tab: 'processed', rowNumber: 7, row }).url), /processed!A7:S7\?valueInputOption=RAW$/);
  const app = L.upsertCall({ sheetId: 's', tab: 'processed', rowNumber: null, row });
  assert.strictEqual(app.method, 'POST');
  assert.match(decodeURIComponent(app.url), /:append\?/);
});

test('spend: daily cap counts the calls a file needs (chunks + 1 when chunked); token ceiling; cost only with prices', () => {
  const cfg = { dailyCallCap: 50, perFileTokenCeiling: 100000 };
  assert.deepStrictEqual(SP.gate({ callsToday: 49, chunks: 1, textChars: 1000, cfg }), { allowed: true, reason: '', need: 1 });
  assert.strictEqual(SP.gate({ callsToday: 48, chunks: 2, textChars: 1000, cfg }).reason, 'daily_cap');
  assert.strictEqual(SP.gate({ callsToday: 0, chunks: 1, textChars: 400004, cfg }).reason, 'token_ceiling');
  assert.strictEqual(SP.costUsd({ input_tokens: 1e6, output_tokens: 1e6 }, { priceInputPerMTokUsd: null, priceOutputPerMTokUsd: null }), null);
  assert.strictEqual(SP.costUsd({ input_tokens: 2e6, output_tokens: 5e5 }, { priceInputPerMTokUsd: 1, priceOutputPerMTokUsd: 2 }), 3);
  assert.strictEqual(L.callsOn(L.rowsToRecords([L.COLUMNS, L.buildRow({ file_id: 'a', status: 'done', model_calls: 3, processed_at: '2026-11-24T01:00:00Z' }), L.buildRow({ file_id: 'b', status: 'done', model_calls: 2, processed_at: '2026-11-23T23:00:00Z' })]), '2026-11-24'), 3);
});

test('sidecar: reason, raw output, candidates, the summary already extracted, and how to resolve', () => {
  const s = R.buildSidecar({ fileName: 'x.vtt', fileId: 'f', reason: 'unmatched', rawOutput: '{"a":1}', candidates: [{ id: '1', name: 'A', domain: null }], ex: ex(), promptVersion: 'extract-v0.1', processedAt: 't' });
  assert.strictEqual(R.sidecarName('x.vtt'), 'x.review.json');
  assert.deepStrictEqual(s.candidates, [{ companyId: '1', name: 'A', domain: null }]);
  assert.ok(s.extracted.summary.length > 0);
  assert.match(s.howToResolve, /\.match\.json/);
  const body = R.multipartUpload({ name: 'x.review.json', parentId: 'p', json: s });
  assert.match(body, /"parents":\["p"\]/);
});

test('error shaping: alert throttled to one per 15 minutes, row has no stack', () => {
  const err = { execution: { id: '12', lastNodeExecuted: 'Create note', error: { message: 'HTTP 403 forbidden\n  at stack' } } };
  const a = R.shapeError(err, null, 1e12);
  assert.strictEqual(a.send, true);
  assert.deepStrictEqual(a.row.slice(1), ['12', 'Create note', 'HTTP 403 forbidden at stack']);
  assert.strictEqual(R.shapeError(err, 1e12, 1e12 + 60000).send, false);
  assert.strictEqual(R.shapeError(err, 1e12, 1e12 + 16 * 60000).send, true);
});
