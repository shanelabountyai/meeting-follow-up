'use strict';
// Strict validator for the extraction contract (PRD §3, prompts/extract.schema.json). Hand-written so it runs
// in an n8n Code node with no packages; test/schema.test.js cross-checks it against the JSON Schema with Ajv.
// Any extra key, missing required key or wrong type is a `schema` failure. Two limits the JSON Schema only
// describes are enforced here as well: followUp.body at most 180 words, and real calendar dates.

const KEYS = ['title', 'meetingDate', 'attendees', 'summary', 'decisions', 'actionItems', 'openQuestions', 'companyMentions', 'dealReference', 'followUp', 'confidence'];
const MAX_BODY_WORDS = 180;

const isStr = (v) => typeof v === 'string';
const nonEmpty = (v) => isStr(v) && v.trim().length > 0;
function isDate(v) {
  if (!isStr(v) || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const prob = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const wordCount = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

function exactKeys(o, keys, path, errors) {
  for (const k of keys) if (!(k in o)) errors.push(`${path}${k}: missing`);
  for (const k of Object.keys(o)) if (!keys.includes(k)) errors.push(`${path}${k}: unexpected key`);
}

function validateExtraction(o) {
  const errors = [];
  if (!isObj(o)) return { ok: false, errors: ['root: not an object'] };
  exactKeys(o, KEYS, '', errors);
  if ('title' in o && !(nonEmpty(o.title) && o.title.length <= 80)) errors.push('title: string of 1 to 80 characters');
  if ('meetingDate' in o && !(o.meetingDate === null || isDate(o.meetingDate))) errors.push('meetingDate: YYYY-MM-DD or null');
  if ('attendees' in o) {
    if (!Array.isArray(o.attendees)) errors.push('attendees: array');
    else o.attendees.forEach((a, i) => {
      if (!isObj(a)) { errors.push(`attendees[${i}]: object`); return; }
      exactKeys(a, ['name', 'email', 'external'], `attendees[${i}].`, errors);
      if ('name' in a && !nonEmpty(a.name)) errors.push(`attendees[${i}].name: non-empty string`);
      if ('email' in a && !(a.email === null || isStr(a.email))) errors.push(`attendees[${i}].email: string or null`);
      if ('external' in a && typeof a.external !== 'boolean') errors.push(`attendees[${i}].external: boolean`);
    });
  }
  if ('summary' in o && !nonEmpty(o.summary)) errors.push('summary: non-empty string');
  for (const k of ['decisions', 'openQuestions', 'companyMentions']) {
    if (!(k in o)) continue;
    if (!Array.isArray(o[k]) || !o[k].every(nonEmpty)) errors.push(`${k}: array of non-empty strings`);
  }
  if ('actionItems' in o) {
    if (!Array.isArray(o.actionItems)) errors.push('actionItems: array');
    else o.actionItems.forEach((a, i) => {
      if (!isObj(a)) { errors.push(`actionItems[${i}]: object`); return; }
      exactKeys(a, ['owner', 'task', 'due', 'quote'], `actionItems[${i}].`, errors);
      for (const k of ['owner', 'task', 'quote']) if (k in a && !nonEmpty(a[k])) errors.push(`actionItems[${i}].${k}: non-empty string`);
      if ('due' in a && !(a.due === null || isDate(a.due))) errors.push(`actionItems[${i}].due: YYYY-MM-DD or null`);
    });
  }
  if ('dealReference' in o && !(o.dealReference === null || nonEmpty(o.dealReference))) errors.push('dealReference: non-empty string or null');
  if ('followUp' in o) {
    if (!isObj(o.followUp)) errors.push('followUp: object');
    else {
      exactKeys(o.followUp, ['subject', 'body'], 'followUp.', errors);
      if ('subject' in o.followUp && !nonEmpty(o.followUp.subject)) errors.push('followUp.subject: non-empty string');
      if ('body' in o.followUp) {
        if (!nonEmpty(o.followUp.body)) errors.push('followUp.body: non-empty string');
        else if (wordCount(o.followUp.body) > MAX_BODY_WORDS) errors.push(`followUp.body: more than ${MAX_BODY_WORDS} words`);
      }
    }
  }
  if ('confidence' in o) {
    if (!isObj(o.confidence)) errors.push('confidence: object');
    else {
      exactKeys(o.confidence, ['summary', 'actionItems'], 'confidence.', errors);
      for (const k of ['summary', 'actionItems']) if (k in o.confidence && !prob(o.confidence[k])) errors.push(`confidence.${k}: number from 0 to 1`);
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { validateExtraction, isDate, wordCount, MAX_BODY_WORDS, KEYS };
