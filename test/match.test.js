'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/match');

const res = (...cos) => ({ results: cos.map(([id, name, domain]) => ({ id, properties: { name, domain } })) });
const deals = (...ids) => ({ results: ids.map((id) => ({ id, properties: { dealname: 'x' } })) });
const none = { results: [] };

test('rule 1: one company by attendee domain wins', () => {
  const m = M.decideMatch({ domainRes: res(['1', 'Acme', 'acme.example']), dealRes: none, nameRes: res(['2', 'Other', 'o.example']) });
  assert.deepStrictEqual([m.matched, m.rule, m.companyId], [true, 'domain', '1']);
});

test('rule 1 with two companies falls through to rule 2 (deal with exactly one company)', () => {
  const m = M.decideMatch({ domainRes: res(['1', 'A', 'a.example'], ['2', 'B', 'b.example']), dealRes: deals('9'), dealCompanyIds: [2], nameRes: none });
  assert.deepStrictEqual([m.rule, m.companyId, m.dealId], ['deal', '2', '9']);
});

test('rule 2 needs exactly one deal hit and exactly one associated company', () => {
  assert.strictEqual(M.decideMatch({ domainRes: none, dealRes: deals('9', '10'), dealCompanyIds: [], nameRes: none }).matched, false);
  assert.strictEqual(M.decideMatch({ domainRes: none, dealRes: deals('9'), dealCompanyIds: [1, 2], nameRes: none }).matched, false);
  assert.strictEqual(M.decideMatch({ domainRes: none, dealRes: deals('9'), dealCompanyIds: [], nameRes: none }).matched, false);
});

test('rule 3: exactly one company across all mentions; several become candidates (max 3), never a guess', () => {
  const one = M.decideMatch({ domainRes: none, dealRes: none, nameRes: res(['5', 'Acme', 'acme.example'], ['5', 'Acme', 'acme.example']) });
  assert.deepStrictEqual([one.rule, one.companyId], ['name', '5']);
  const many = M.decideMatch({ domainRes: none, dealRes: none, nameRes: res(['5', 'A', null], ['6', 'B', null], ['7', 'C', null], ['8', 'D', null]) });
  assert.deepStrictEqual([many.matched, many.rule, many.candidates.map((c) => c.id)], [false, 'none', ['5', '6', '7']]);
});

test('rule 4 candidates: rule-3 hits first, then rule-1 hits, de-duplicated', () => {
  const m = M.decideMatch({ domainRes: res(['1', 'A', 'a.example'], ['2', 'B', 'b.example']), dealRes: none, nameRes: res(['2', 'B', 'b.example'], ['3', 'C', 'c.example']) });
  assert.deepStrictEqual(m.candidates.map((c) => c.id), ['2', '3', '1']);
});

test('a deal is attached to a domain or name match only when the single deal hit belongs to that company', () => {
  const yes = M.decideMatch({ domainRes: res(['1', 'A', 'a.example']), dealRes: deals('9'), dealCompanyIds: ['1'], nameRes: none });
  assert.deepStrictEqual([yes.companyId, yes.dealId], ['1', '9']);
  const no = M.decideMatch({ domainRes: res(['1', 'A', 'a.example']), dealRes: deals('9'), dealCompanyIds: ['4'], nameRes: none });
  assert.deepStrictEqual([no.companyId, no.dealId], ['1', null]);
});

test('a .match.json override skips the rules', () => {
  const m = M.decideMatch({ override: { companyId: '77', dealId: null }, domainRes: res(['1', 'A', 'a.example']), dealRes: none, nameRes: none });
  assert.deepStrictEqual([m.rule, m.companyId], ['override', '77']);
  assert.deepStrictEqual(M.parseOverride('{"companyId": 123, "dealId": "456"}'), { companyId: '123', dealId: '456' });
  assert.throws(() => M.parseOverride('{"companyId": "Acme"}'), /digits/);
  assert.throws(() => M.parseOverride('not json'));
});

test('planSearches: own domains excluded, EQ only, never an unfiltered search, at most 5 groups', () => {
  const q = M.planSearches({
    headerEmails: ['me@tallgrassadvisory.example', 'a@acme.example', 'b@acme.example'],
    ownDomains: ['tallgrassadvisory.example'],
    ex: { companyMentions: ['A', 'B', 'C', 'D', 'E', 'F'], dealReference: null },
    attendeeEmails: ['a@acme.example', 'me@tallgrassadvisory.example', null],
  });
  assert.deepStrictEqual(q.domains, ['acme.example']);
  assert.strictEqual(q.nameSearch.filterGroups.length, 5);
  assert.match(q.skipped.join(), /F/);
  assert.deepStrictEqual(q.dealSearch.filterGroups, [{ filters: [{ propertyName: 'dealname', operator: 'EQ', value: M.NONE }] }]);
  assert.deepStrictEqual(q.contactSearch.filterGroups.map((g) => g.filters[0].value), ['a@acme.example']);
  for (const s of [q.domainSearch, q.dealSearch, q.nameSearch, q.contactSearch]) {
    assert.ok(s.filterGroups.length >= 1 && s.filterGroups.length <= 5);
    assert.ok(s.filterGroups.every((g) => g.filters.every((f) => f.operator === 'EQ')));
  }
});

test('notInCrm lists external attendees with an email and no contact', () => {
  const atts = [{ name: 'A', email: 'a@x.example' }, { name: 'B', email: 'b@x.example' }, { name: 'C', email: null }, { name: 'Me', email: 'me@own.example' }];
  assert.deepStrictEqual(M.notInCrm(atts, { results: [{ id: '1', properties: { email: 'A@x.example' } }] }, ['own.example']), ['B']);
});
