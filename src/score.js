'use strict';
// Fixture scoring (PRD §5): action-item recall and precision per fixture, and whether the company outcome is
// right (matched to the expected company, or routed to Needs-Review; a wrong company is the failure that counts).
const N = require('./normalize');

// A predicted item matches an expected one when the owners are equal and one quote contains the other
// (folded the same way the checks fold). Each expected item can be matched once.
function scoreItems(expected, predicted) {
  const used = new Set();
  let tp = 0;
  for (const p of predicted) {
    const pq = N.foldForMatch(p.quote);
    const i = expected.findIndex((e, k) => !used.has(k) && e.owner === p.owner && (pq.includes(N.foldForMatch(e.quote)) || N.foldForMatch(e.quote).includes(pq)));
    if (i >= 0) { used.add(i); tp++; }
  }
  return { tp, expected: expected.length, predicted: predicted.length, fn: expected.length - tp, fp: predicted.length - tp };
}

function companyOutcome(expected, match) {
  if (!match) return 'not_reached';
  if (match.matched) {
    if (expected.companyId && match.companyId === expected.companyId) return 'correct';
    return 'wrong_company';
  }
  return expected.outcome === 'review' && expected.reason === 'unmatched' ? 'correct_review' : 'review_instead_of_match';
}

function aggregate(rows) {
  const t = rows.reduce((a, r) => ({ tp: a.tp + r.items.tp, e: a.e + r.items.expected, p: a.p + r.items.predicted }), { tp: 0, e: 0, p: 0 });
  return {
    recall: t.e ? t.tp / t.e : 1,
    precision: t.p ? t.tp / t.p : 1,
    wrongCompany: rows.filter((r) => r.company === 'wrong_company').length,
    totals: t,
  };
}

module.exports = { scoreItems, companyOutcome, aggregate };
