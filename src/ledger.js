'use strict';
// The `processed` sheet is the ledger (PRD §1 step 3, §4 Idempotency). One row per transcript, keyed by the
// Drive file id, with a content hash as a second key so a re-uploaded copy (new file id) still finds its row.
// Only ids, status codes and numbers are written: never transcript text, names or emails (PRD §4 PII).

const COLUMNS = [
  'file_id', 'content_hash', 'status', 'reason', 'match_rule', 'company_id', 'deal_id', 'note_id', 'draft_id', 'draft_state',
  'prompt_version', 'model', 'model_calls', 'input_tokens', 'output_tokens', 'cost_usd', 'runtime_s', 'override', 'processed_at',
];
// Values a reason/status/state column may hold. Anything else is refused, so free text cannot reach the sheet.
const STATUS = ['done', 'review', 'failed', 'waiting'];
const REASONS = ['', 'schema', 'unmatched', 'low_confidence', 'unverified_quotes', 'followup_placeholder', 'followup_link',
  'model_error', 'hubspot_error', 'gmail_error', 'override_invalid', 'unreadable', 'empty_transcript', 'daily_cap', 'token_ceiling'];
const DRAFT_STATES = ['', 'created', 'updated', 'gone', 'no_recipients', 'skipped'];
const MATCH_RULES = ['', 'override', 'domain', 'deal', 'name', 'none'];

function rowsToRecords(values) {
  const rows = Array.isArray(values) ? values : [];
  if (!rows.length) return [];
  const header = rows[0].map(String);
  return rows.slice(1).map((r, i) => ({ rowNumber: i + 2, ...Object.fromEntries(header.map((h, j) => [h, r[j] ?? ''])) }));
}

function findRecord(records, fileId, contentHash) {
  return records.find((r) => r.file_id === fileId) || (contentHash ? records.find((r) => r.content_hash === contentHash) : undefined) || null;
}

// PRD §4: done → update the existing note and draft by id; failed (and review/waiting) → retry; none → create.
function decidePath(record) {
  if (!record) return 'create';
  return record.status === 'done' ? 'update' : 'retry';
}

const ID = /^[A-Za-z0-9_-]*$/;
const NUM = /^\d*(\.\d+)?$/;

function buildRow(f) {
  for (const k of Object.keys(f)) if (!COLUMNS.includes(k)) throw new Error(`ledger: unknown column ${k}`);
  const v = Object.fromEntries(COLUMNS.map((c) => [c, f[c] === undefined || f[c] === null ? '' : String(f[c])]));
  if (!STATUS.includes(v.status)) throw new Error(`ledger: bad status ${v.status}`);
  if (!REASONS.includes(v.reason)) throw new Error(`ledger: bad reason ${v.reason}`);
  if (!DRAFT_STATES.includes(v.draft_state)) throw new Error(`ledger: bad draft_state ${v.draft_state}`);
  if (!MATCH_RULES.includes(v.match_rule)) throw new Error(`ledger: bad match_rule ${v.match_rule}`);
  for (const c of ['file_id', 'content_hash', 'company_id', 'deal_id', 'note_id', 'draft_id']) if (!ID.test(v[c])) throw new Error(`ledger: ${c} is not an id`);
  for (const c of ['model_calls', 'input_tokens', 'output_tokens', 'cost_usd', 'runtime_s']) if (!NUM.test(v[c])) throw new Error(`ledger: ${c} is not a number`);
  if (!/^[a-z]+-v\d+\.\d+$|^$/.test(v.prompt_version)) throw new Error('ledger: bad prompt_version');
  if (!/^[a-z0-9.-]*$/.test(v.model)) throw new Error('ledger: bad model id');
  if (!['', 'match.json'].includes(v.override)) throw new Error('ledger: bad override');
  if (!/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)?$/.test(v.processed_at)) throw new Error('ledger: processed_at must be ISO UTC');
  return COLUMNS.map((c) => v[c]);
}

// Google Sheets API v4 call for an upsert: update the row in place, or append. tab is the sheet tab name.
const colLetter = (n) => { let s = ''; for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s; };
function upsertCall({ sheetId, tab, rowNumber, row }) {
  const last = colLetter(COLUMNS.length);
  if (rowNumber) {
    return { method: 'PUT', url: `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(`${tab}!A${rowNumber}:${last}${rowNumber}`)}?valueInputOption=RAW`, body: { values: [row] } };
  }
  return { method: 'POST', url: `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(`${tab}!A1:${last}1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, body: { values: [row] } };
}

// Model calls already made today (UTC date of processed_at), for the per-day cap (PRD §4 Spend).
function callsOn(records, dateIso) {
  return records.filter((r) => String(r.processed_at).slice(0, 10) === dateIso).reduce((s, r) => s + (Number(r.model_calls) || 0), 0);
}

module.exports = { COLUMNS, STATUS, REASONS, DRAFT_STATES, rowsToRecords, findRecord, decidePath, buildRow, upsertCall, callsOn, colLetter };
