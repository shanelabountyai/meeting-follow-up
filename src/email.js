'use strict';
// The follow-up draft (PRD §1 step 7, §4). Recipients come from code, never from the model: an attendee is a
// recipient only if their email is in the transcript header or Attendees line and is not one of our own domains.
// This module builds a draft; there is no send function anywhere in this repo.

const own = (email, ownDomains) => (ownDomains || []).map((d) => d.toLowerCase()).includes(String(email).toLowerCase().split('@')[1] || '');
const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

function recipients(ex, headerEmails, ownDomains) {
  const allowed = new Set((headerEmails || []).map((e) => e.toLowerCase()));
  const out = [];
  for (const a of ex.attendees) {
    const e = a.email && a.email.toLowerCase();
    if (e && allowed.has(e) && !own(e, ownDomains) && !out.some((r) => r.email === e)) out.push({ name: oneLine(a.name), email: e });
  }
  return out;
}

function subjectFor(ex, fallbackDate) {
  return oneLine(`Follow-up: ${ex.title} — ${ex.meetingDate || fallbackDate}`).slice(0, 200);
}

function bodyFor(ex, recips) {
  const names = new Set(recips.map((r) => r.name));
  const theirs = ex.actionItems.filter((a) => names.has(a.owner));
  let body = String(ex.followUp.body).replace(/\r\n?/g, '\n').trim();
  if (theirs.length) body += '\n\nYour action items:\n' + theirs.map((a) => `- ${oneLine(a.task)} (${oneLine(a.owner)}${a.due ? `, due ${a.due}` : ''})`).join('\n');
  return body;
}

function buildDraft({ ex, headerEmails, ownDomains, fallbackDate, fromAddress }) {
  const to = recipients(ex, headerEmails, ownDomains);
  return { to, sendTo: to.map((r) => r.email).join(', '), subject: subjectFor(ex, fallbackDate), body: bodyFor(ex, to), from: fromAddress || '' };
}

// RFC 2822 message for the Gmail drafts.update call (PUT /gmail/v1/users/me/drafts/{id}).
function encodeHeader(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}
function mimeRaw({ from, sendTo, subject, body }) {
  const lines = [];
  if (from) lines.push(`From: ${oneLine(from)}`);
  lines.push(`To: ${oneLine(sendTo)}`, `Subject: ${encodeHeader(oneLine(subject))}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', Buffer.from(body, 'utf8').toString('base64'));
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const updateDraftBody = ({ draftId, draft }) => ({ id: String(draftId), message: { raw: mimeRaw(draft) } });

module.exports = { recipients, subjectFor, bodyFor, buildDraft, mimeRaw, updateDraftBody };
