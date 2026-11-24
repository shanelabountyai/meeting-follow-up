'use strict';
// "Checks after validation" (PRD §3: every miss, of any kind, drops the item and costs 0.1 of
// confidence.actionItems; three misses fail the file), plus the code-side guards that make prompt injection in a transcript
// harmless: nothing the model writes can add a recipient, and the follow-up may carry no link or address at all.
const N = require('./normalize');

const FORBIDDEN_CHARS = /[[\]{}]/;
const FORBIDDEN_WORDS = /\b(TBD|insert|placeholder)\b/i;
// A link: scheme, www., host/path, or a bare host on a common TLD. Draft-bound text may contain none (DECISIONS D-15).
const TLDS = 'com|net|org|io|co|ai|app|dev|info|biz|me|us|uk|de|fr|eu|ca|au|xyz|ly|link|site|online|shop|pay|money|example';
const URL_RE = new RegExp(`\\b(?:https?:\\/\\/|www\\.)[^\\s<>()]+|\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)+\\/[^\\s<>()]*|\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${TLDS})\\b`, 'gi');

// Every string that can reach the email draft. Links and addresses are refused in all of them; a person can add
// real links when sending.
function linksIn(text) {
  return [...N.emailsIn(text), ...(String(text).match(URL_RE) || [])];
}
const LOW_CONFIDENCE = 0.6;
const MAX_MISSES = 3;

const round2 = (x) => Math.round(x * 100) / 100;
const domainOf = (email) => String(email || '').toLowerCase().split('@')[1] || '';
const isOwn = (email, ownDomains) => (ownDomains || []).map((d) => d.toLowerCase()).includes(domainOf(email));

// → { ok, reason, detail, ex, misses, lowConfidence, flags }
// ok:false means the file goes to Needs-Review and nothing is written to HubSpot or Gmail.
function postChecks(input, transcript, opts = {}) {
  const ownDomains = opts.ownDomains || [];
  const hay = N.foldForMatch(transcript);
  const occurs = (s) => !!s && hay.includes(N.foldForMatch(s));
  const allEmails = new Set(N.transcriptEmails(transcript));
  const ex = JSON.parse(JSON.stringify(input));
  const misses = [];
  const flags = [];

  // Attendees: a name must appear in the transcript; an email only if that exact address does.
  ex.attendees = ex.attendees.filter((a) => {
    if (!occurs(a.name)) { flags.push(`attendee dropped, name not in transcript: ${a.name}`); return false; }
    return true;
  }).map((a) => {
    let email = a.email ? a.email.trim().toLowerCase() : null;
    if (email && !allEmails.has(email)) { flags.push(`attendee email removed, not in transcript: ${a.name}`); email = null; }
    return { name: a.name, email, external: email ? !isOwn(email, ownDomains) : a.external };
  });
  const names = new Map(ex.attendees.map((a) => [N.foldForMatch(a.name), a.name]));

  let conf = ex.confidence.actionItems;
  ex.actionItems = ex.actionItems.filter((it) => {
    if (occurs(it.quote)) return true;
    misses.push(`action item quote not in transcript: "${it.quote.slice(0, 80)}"`);
    conf -= 0.1;
    return false;
  }).map((it) => {
    const owner = names.get(N.foldForMatch(it.owner));
    if (!owner && it.owner !== 'Unassigned') flags.push(`owner not an attendee, set Unassigned: ${it.owner}`);
    return { ...it, owner: owner || 'Unassigned' };
  });
  ex.companyMentions = ex.companyMentions.filter((m) => {
    if (occurs(m)) return true;
    misses.push(`company mention not in transcript: "${m}"`);
    conf -= 0.1;
    return false;
  });
  if (ex.dealReference !== null && !occurs(ex.dealReference)) {
    misses.push(`deal reference not in transcript: "${ex.dealReference}"`);
    ex.dealReference = null;
    conf -= 0.1;
  }
  ex.confidence = { ...ex.confidence, actionItems: Math.max(0, round2(conf)) };
  const lowConfidence = ex.confidence.summary < LOW_CONFIDENCE;
  const base = { ex, misses, lowConfidence, flags };

  if (misses.length >= MAX_MISSES) return { ok: false, reason: 'unverified_quotes', detail: misses.join('; '), ...base };

  if (FORBIDDEN_CHARS.test(ex.followUp.body) || FORBIDDEN_WORDS.test(ex.followUp.body)) {
    return { ok: false, reason: 'followup_placeholder', detail: 'followUp.body contains a bracket or TBD/insert/placeholder', ...base };
  }
  // Draft-bound fields: subject is built from the title, the body appends action-item tasks and owner names.
  const draftText = [ex.title, ex.followUp.subject, ex.followUp.body, ...ex.actionItems.map((a) => `${a.task} ${a.owner}`), ...ex.attendees.map((a) => a.name)].join('\n');
  const links = linksIn(draftText);
  if (links.length) {
    return { ok: false, reason: 'followup_link', detail: `draft text contains a link or address: ${links.join(', ')}`, ...base };
  }
  return { ok: true, reason: lowConfidence ? 'low_confidence' : '', detail: '', ...base };
}

module.exports = { postChecks, linksIn, URL_RE, LOW_CONFIDENCE, MAX_MISSES, domainOf, isOwn, FORBIDDEN_WORDS, FORBIDDEN_CHARS };
