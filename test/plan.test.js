'use strict';
const test = require('node:test');
const assert = require('node:assert');
const steps = require('../src/steps');
const L = require('../src/ledger');
const cfg = require('../fixtures/test-config.json');

const f = (id, name, createdTime, mimeType = 'text/plain') => ({ id, name, createdTime, mimeType, webViewLink: '' });

test('plan: oldest transcript first; sidecars, other files ignored; .match.json paired by base name', () => {
  const listing = [
    f('3', 'b.vtt', '2026-11-03T00:00:00Z'), f('1', 'a.txt', '2026-11-01T00:00:00Z'), f('9', 'a.match.json', '2026-11-05T00:00:00Z', 'application/json'),
    f('8', 'a.review.json', '2026-10-01T00:00:00Z', 'application/json'), f('7', 'deck.pdf', '2026-10-01T00:00:00Z', 'application/pdf'),
  ];
  const p = steps.plan({ cfg, listing, ledgerValues: [], nowIso: '2026-11-24T00:00:00Z' });
  assert.strictEqual(p.action, 'process');
  assert.strictEqual(p.file.id, '1');
  assert.strictEqual(p.override.id, '9');
  assert.strictEqual(p.remaining, 1);
  assert.match(p.downloadUrl, /files\/1\?alt=media&supportsAllDrives=true$/);
});

test('plan: a Google Doc (Meet transcript) is exported as plain text', () => {
  const p = steps.plan({ cfg, listing: [f('g1', 'Meeting transcript', '2026-11-01T00:00:00Z', steps.GDOC)], ledgerValues: [], nowIso: '2026-11-24T00:00:00Z' });
  assert.strictEqual(p.file.kind, 'gdoc');
  assert.match(p.downloadUrl, /files\/g1\/export\?mimeType=text\/plain$/);
  assert.strictEqual(steps.toText('gdoc', Buffer.from('﻿Ann: hi\r\n')), 'Ann: hi');
});

test('plan: idle on an empty Inbox; cap reached stops before any download', () => {
  assert.strictEqual(steps.plan({ cfg, listing: [], ledgerValues: [], nowIso: '2026-11-24T00:00:00Z' }).action, 'idle');
  const ledger = [L.COLUMNS, L.buildRow({ file_id: 'x', status: 'done', model_calls: 50, processed_at: '2026-11-24T01:00:00Z' })];
  assert.strictEqual(steps.plan({ cfg, listing: [f('1', 'a.txt', '')], ledgerValues: ledger, nowIso: '2026-11-24T09:00:00Z' }).action, 'cap');
  assert.strictEqual(steps.plan({ cfg, listing: [f('1', 'a.txt', '')], ledgerValues: ledger, nowIso: '2026-11-25T09:00:00Z' }).action, 'process', 'new UTC day');
});

test('normalise: unreadable, empty and bad .match.json files go to review without a model call', () => {
  const prompts = { extract: 's', reduce: 'r', schema: { type: 'object' }, version: 'extract-v0.1' };
  const planned = { file: { id: '1', name: 'a.docx', kind: '.docx' }, override: null, callsToday: 0, remaining: 0 };
  assert.strictEqual(steps.normalise({ cfg, planned, buffer: Buffer.from('nope'), ledgerValues: [], prompts }).reason, 'unreadable');
  const txt = { ...planned, file: { id: '1', name: 'a.txt', kind: '.txt' } };
  assert.strictEqual(steps.normalise({ cfg, planned: txt, buffer: Buffer.from('  '), ledgerValues: [], prompts }).reason, 'empty_transcript');
  const ovr = { ...txt, override: { id: '2', name: 'a.match.json' } };
  const r = steps.normalise({ cfg, planned: ovr, buffer: Buffer.from('Ann: a long enough transcript line here'), overrideJson: '{"companyId":"abc"}', ledgerValues: [], prompts });
  assert.deepStrictEqual([r.route, r.reason], ['review', 'override_invalid']);
  const fin = steps.finish({ cfg, prompts, nowIso: '2026-11-24T00:00:00.000Z', planned: ovr, normalised: r });
  assert.strictEqual(fin.status, 'review');
  assert.strictEqual(fin.move.to, cfg.needsReviewFolderId);
  assert.strictEqual(fin.moveOverride.to, cfg.needsReviewFolderId);
  assert.strictEqual(fin.row[12], '0', 'no model call made');
});
