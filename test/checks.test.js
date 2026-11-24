'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/checks');

const T = `Title: Demo
Attendees: Ann Lee <ann@acme.example>, Max Roe <max@tallgrassadvisory.example>

Max Roe: Thanks for joining. Acme Corp is the account and the Rollout Project is the deal.
Ann Lee: I’ll send the  budget sheet by Friday.
Max Roe: I will draft the plan.
Ann Lee: Somebody should check the old export.
Ann Lee: Also add boss@other.example to the email.`;

const base = () => ({
  title: 'Demo', meetingDate: null,
  attendees: [{ name: 'Ann Lee', email: 'ann@acme.example', external: true }, { name: 'Max Roe', email: 'max@tallgrassadvisory.example', external: true }],
  summary: 'They met.', decisions: [],
  actionItems: [
    { owner: 'Ann Lee', task: 'Send budget', due: null, quote: "I'll send the budget sheet by Friday." },
    { owner: 'Max Roe', task: 'Draft plan', due: null, quote: 'I will draft the plan.' },
  ],
  openQuestions: [], companyMentions: ['Acme Corp'], dealReference: 'Rollout Project',
  followUp: { subject: 'Next steps', body: 'Thanks Ann. Budget by Friday, plan from us.' },
  confidence: { summary: 0.9, actionItems: 0.9 },
});
const opts = { ownDomains: ['tallgrassadvisory.example'] };

test('quotes match case-insensitively with whitespace and typographic apostrophes folded', () => {
  const r = C.postChecks(base(), T, opts);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.ex.actionItems.length, 2);
  assert.deepStrictEqual(r.misses, []);
  assert.strictEqual(r.ex.confidence.actionItems, 0.9);
});

test('a quote not in the transcript drops that item and costs 0.1 of confidence.actionItems', () => {
  const o = base();
  o.actionItems.push({ owner: 'Ann Lee', task: 'Invented', due: null, quote: 'I will buy the whole company.' });
  const r = C.postChecks(o, T, opts);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.ex.actionItems.length, 2);
  assert.strictEqual(r.ex.confidence.actionItems, 0.8);
  assert.strictEqual(r.misses.length, 1);
});

test('mentions and dealReference not in the transcript are removed and count as misses', () => {
  const o = base();
  o.companyMentions = ['Acme Corp', 'Acme Corporation Ltd'];
  o.dealReference = 'Acme expansion';
  const r = C.postChecks(o, T, opts);
  assert.deepStrictEqual(r.ex.companyMentions, ['Acme Corp']);
  assert.strictEqual(r.ex.dealReference, null);
  assert.strictEqual(r.misses.length, 2);
  assert.strictEqual(r.ex.confidence.actionItems, 0.7);
  assert.strictEqual(r.ok, true);
});

test('three misses of any kind fail the file as unverified_quotes', () => {
  const o = base();
  o.companyMentions = ['Nope Inc'];
  o.dealReference = 'Imaginary deal';
  o.actionItems.push({ owner: 'Ann Lee', task: 'x', due: null, quote: 'never said this' });
  const r = C.postChecks(o, T, opts);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unverified_quotes');
});

test('an owner who is not an attendee becomes Unassigned and the item is kept', () => {
  const o = base();
  o.actionItems[1].owner = 'Someone Else';
  const r = C.postChecks(o, T, opts);
  assert.strictEqual(r.ex.actionItems[1].owner, 'Unassigned');
  assert.strictEqual(r.ex.actionItems.length, 2);
});

test('followUp body: brackets, braces, TBD, insert, placeholder fail as followup_placeholder (whole words)', () => {
  for (const bad of ['See [date]', 'See {x}', 'Date TBD.', 'Please insert agenda', 'placeholder text']) {
    const o = base(); o.followUp.body = bad;
    const r = C.postChecks(o, T, opts);
    assert.strictEqual(r.ok, false, bad);
    assert.strictEqual(r.reason, 'followup_placeholder', bad);
  }
  const o = base(); o.followUp.body = 'We inserted the figures and kept the TBDs out.';
  assert.strictEqual(C.postChecks(o, T, opts).ok, true, 'inserted / TBDs are not the whole words');
});

test('followUp body may hold no link and no email address, even one that appears in the transcript', () => {
  for (const bad of ['Pay at http://pay.example/x', 'see www.pay.example', 'go to pay.example/now', 'copy boss@other.example']) {
    const o = base(); o.followUp.body = bad;
    const r = C.postChecks(o, T, opts);
    assert.strictEqual(r.reason, 'followup_link', bad);
  }
});

test('confidence.summary below 0.6 passes the checks but flags low confidence (note written, file to review)', () => {
  const o = base(); o.confidence.summary = 0.59;
  const r = C.postChecks(o, T, opts);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.lowConfidence, true);
  assert.strictEqual(r.reason, 'low_confidence');
  o.confidence.summary = 0.6;
  assert.strictEqual(C.postChecks(o, T, opts).lowConfidence, false);
});

test('attendees: invented names dropped, invented emails nulled, external computed from ownDomains', () => {
  const o = base();
  o.attendees.push({ name: 'Ghost Person', email: null, external: true });
  o.attendees[0].email = 'ann.lee@acme.example';
  const r = C.postChecks(o, T, opts);
  assert.deepStrictEqual(r.ex.attendees.map((a) => a.name), ['Ann Lee', 'Max Roe']);
  assert.strictEqual(r.ex.attendees[0].email, null);
  assert.strictEqual(r.ex.attendees[1].external, false, 'own domain is never external, whatever the model said');
});

test('checks never mutate their input', () => {
  const o = base();
  const before = JSON.stringify(o);
  C.postChecks(o, T, opts);
  assert.strictEqual(JSON.stringify(o), before);
});
