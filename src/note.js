'use strict';
// The HubSpot note (PRD §1 step 6): the only CRM write. Every model-written string is HTML-escaped, so a
// transcript cannot inject markup or links into the CRM. Association type ids are HubSpot-defined:
// note→company 190, note→deal 214.

const FOOTER = 'Drafted by N7 · review before relying on it';
const NOTE_TO_COMPANY = 190;
const NOTE_TO_DEAL = 214;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const list = (items) => (items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>` : '<p>None recorded.</p>');

function renderNote({ ex, driveLink, lowConfidence, notInCrm, promptVersion }) {
  const parts = [];
  if (lowConfidence) parts.push(`<p><strong>Low confidence</strong> (summary ${esc(ex.confidence.summary)}): check this note against the transcript before relying on it.</p>`);
  parts.push(`<h3>${esc(ex.title)}${ex.meetingDate ? ` (${esc(ex.meetingDate)})` : ''}</h3>`);
  parts.push(`<p><strong>Summary</strong></p><p>${esc(ex.summary)}</p>`);
  parts.push('<p><strong>Decisions</strong></p>' + list(ex.decisions.map(esc)));
  parts.push('<p><strong>Action items</strong></p>' + list(ex.actionItems.map((a) => `☐ ${esc(a.task)} (owner: ${esc(a.owner)}; due: ${esc(a.due || 'not set')})`)));
  if (ex.openQuestions.length) parts.push('<p><strong>Open questions</strong></p>' + list(ex.openQuestions.map(esc)));
  if (notInCrm && notInCrm.length) parts.push(`<p><strong>Attendees not in CRM</strong> (no contact created): ${notInCrm.map(esc).join(', ')}</p>`);
  if (driveLink && /^https:\/\/(drive|docs)\.google\.com\//.test(driveLink)) parts.push(`<p><a href="${esc(driveLink)}">Transcript in Drive</a></p>`);
  parts.push(`<p><em>${esc(FOOTER)}</em> · prompt ${esc(promptVersion)}</p>`);
  return parts.join('\n');
}

function createNoteBody({ html, timestampIso, ownerId, companyId, dealId }) {
  const associations = [{ to: { id: String(companyId) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_COMPANY }] }];
  if (dealId) associations.push({ to: { id: String(dealId) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_DEAL }] });
  const properties = { hs_timestamp: timestampIso, hs_note_body: html };
  if (ownerId) properties.hubspot_owner_id = String(ownerId);
  return { properties, associations };
}

const updateNoteBody = ({ html }) => ({ properties: { hs_note_body: html } });

module.exports = { renderNote, createNoteBody, updateNoteBody, FOOTER, NOTE_TO_COMPANY, NOTE_TO_DEAL, esc };
