'use strict';
// One function per Code node in workflow.json. Each takes plain inputs (what the node reads from earlier nodes)
// and returns plain JSON, so the offline harness (test/harness.js) runs exactly the logic the workflow runs.
const N = require('./normalize');
const S = require('./schema');
const X = require('./extract');
const C = require('./checks');
const M = require('./match');
const NOTE = require('./note');
const E = require('./email');
const L = require('./ledger');
const SP = require('./spend');
const R = require('./review');

const GDOC = 'application/vnd.google-apps.document';

function isTranscriptFile(f) {
  return f.mimeType === GDOC || N.classify(f.name) === 'transcript';
}

// Plan: pick the oldest transcript in Inbox that is not parked, pair it with its .match.json, read its ledger row.
// One file per execution; the workflow re-invokes itself while more remain (see "Next file").
function plan({ cfg, listing, ledgerValues, nowIso }) {
  const records = L.rowsToRecords(ledgerValues);
  const callsToday = L.callsOn(records, nowIso.slice(0, 10));
  const files = (listing || []).filter((f) => f && f.id && f.name);
  const overrides = new Map(files.filter((f) => N.classify(f.name) === 'override').map((f) => [N.baseKey(f.name), f]));
  const parked = new Set(records.filter((r) => r.status === 'waiting' && r.reason === 'token_ceiling').map((r) => r.file_id));
  const queue = files.filter(isTranscriptFile).filter((f) => !parked.has(f.id))
    .sort((a, b) => String(a.createdTime || '').localeCompare(String(b.createdTime || '')) || a.name.localeCompare(b.name));
  if (!queue.length) return { action: 'idle', callsToday, remaining: 0 };
  if (callsToday >= cfg.dailyCallCap) return { action: 'cap', callsToday, remaining: queue.length };
  const file = queue[0];
  const override = overrides.get(N.baseKey(file.name)) || null;
  const downloadUrl = file.mimeType === GDOC
    ? `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`
    : `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`;
  return {
    action: 'process',
    file: { id: file.id, name: file.name, mimeType: file.mimeType || '', webViewLink: file.webViewLink || '', kind: file.mimeType === GDOC ? 'gdoc' : N.extOf(file.name) },
    override: override ? { id: override.id, name: override.name, url: `https://www.googleapis.com/drive/v3/files/${override.id}?alt=media&supportsAllDrives=true` } : null,
    downloadUrl,
    claim: { fileId: file.id, from: cfg.inboxFolderId, to: cfg.processingFolderId },
    callsToday,
    remaining: queue.length - 1,
  };
}

function toText(kind, buffer) {
  const buf = Buffer.from(buffer);
  if (kind === '.docx') return N.normalizeText(require('./docx').docxToText(buf));
  const s = buf.toString('utf8');
  return kind === '.vtt' ? N.vttToText(s) : N.normalizeText(s);
}

function sha256(text) {
  return require('crypto').createHash('sha256').update(text, 'utf8').digest('hex');
}

// Normalise: file bytes → text, content hash, ledger record, spend gate, model requests.
// downloadError / overrideError: the Drive download failed after retries. The file still goes to Needs-Review
// (PRD §4: failure is a folder), so one bad file cannot block the queue.
function normalise({ cfg, planned, buffer, overrideJson, ledgerValues, prompts, downloadError, overrideError }) {
  const records = L.rowsToRecords(ledgerValues);
  let text = '';
  let readError = downloadError ? `download failed: ${downloadError}` : null;
  if (!readError) { try { text = toText(planned.file.kind, buffer); } catch (e) { readError = e.message; } }
  const hash = text ? sha256(text) : '';
  const record = L.findRecord(records, planned.file.id, hash);
  const common = { file: planned.file, remaining: planned.remaining, hash, record, path: L.decidePath(record), override: null, overrideFile: planned.override };
  if (readError) return { ...common, route: 'review', reason: 'unreadable', detail: readError };
  if (planned.override) {
    if (overrideError) return { ...common, route: 'review', reason: 'override_invalid', detail: `download failed: ${overrideError}` };
    try { common.override = M.parseOverride(overrideJson); } catch (e) { return { ...common, route: 'review', reason: 'override_invalid', detail: e.message }; }
  }
  if (!text || text.length < 20) return { ...common, route: 'review', reason: 'empty_transcript', detail: 'no readable text' };
  const chunks = N.chunkBySpeakerTurn(text, cfg.chunkChars);
  const g = SP.gate({ callsToday: planned.callsToday, chunks: chunks.length, textChars: text.length, cfg });
  if (!g.allowed) return { ...common, route: 'wait', reason: g.reason, detail: `needs ${g.need} model call(s)` };
  const requests = chunks.map((c, i) => X.buildRequest({ text: c, part: i + 1, parts: chunks.length, cfg, system: prompts.extract, schema: prompts.schema }));
  return {
    ...common,
    route: 'extract',
    text,
    headerEmails: N.headerEmails(text),
    fallbackDate: N.headerField(text, 'Date') && S.isDate(N.headerField(text, 'Date')) ? N.headerField(text, 'Date') : null,
    chunks: chunks.length,
    requests,
  };
}

// Collect: one response → final; several (map) → a reduce request over the parsed chunk results.
function collect({ responses, cfg, prompts }) {
  const parsed = responses.map(X.parseResponse);
  const usage = parsed.reduce((u, p) => X.addUsage(u, p.usage), { input_tokens: 0, output_tokens: 0 });
  if (parsed.length === 1) return { needReduce: false, final: responses[0], usage: { input_tokens: 0, output_tokens: 0 }, calls: 1 };
  const bad = parsed.findIndex((p) => !p.ok || !S.validateExtraction(p.value).ok);
  if (bad >= 0) {
    const p = parsed[bad];
    const reason = p.ok ? S.validateExtraction(p.value).errors.join('; ') : p.reason;
    return { needReduce: false, failed: { reason: 'schema', detail: `chunk ${bad + 1}: ${reason}`, raw: p.raw }, usage, calls: parsed.length };
  }
  return { needReduce: true, reduceRequest: X.buildReduceRequest({ chunkResults: parsed.map((p) => p.value), cfg, system: prompts.reduce, schema: prompts.schema }), usage, calls: parsed.length + 1 };
}

// Validate: final response → schema → post-checks. usage here is the map usage (0 for single-call files).
function validate({ api, mapUsage, calls, transcript, cfg }) {
  const p = X.parseResponse(api);
  const usage = X.addUsage(mapUsage, p.usage);
  const cost = SP.costUsd(usage, cfg);
  const meter = { usage, calls, cost };
  if (!p.ok) return { ok: false, reason: 'schema', detail: p.reason, raw: p.raw, ...meter };
  const v = S.validateExtraction(p.value);
  if (!v.ok) return { ok: false, reason: 'schema', detail: v.errors.join('; '), raw: p.raw, ...meter };
  const c = C.postChecks(p.value, transcript, { ownDomains: cfg.ownDomains });
  return { ok: c.ok, reason: c.reason, detail: c.detail, raw: c.ok ? '' : p.raw, ex: c.ex, misses: c.misses, flags: c.flags, lowConfidence: c.lowConfidence, ...meter };
}

function planSearches({ normalised, validated, cfg }) {
  return M.planSearches({ headerEmails: normalised.headerEmails, ownDomains: cfg.ownDomains, ex: validated.ex, attendeeEmails: validated.ex.attendees.map((a) => a.email) });
}

function decide({ normalised, validated, domainRes, dealRes, dealAssoc, nameRes, contactRes, cfg }) {
  const dealCompanyIds = (dealAssoc?.results || []).map((r) => r.toObjectId);
  const match = M.decideMatch({ override: normalised.override, domainRes, dealRes, dealCompanyIds, nameRes });
  return { ...match, notInCrm: M.notInCrm(validated.ex.attendees, contactRes, cfg.ownDomains) };
}

function buildNote({ normalised, validated, match, cfg, prompts, nowIso }) {
  const html = NOTE.renderNote({ ex: validated.ex, driveLink: normalised.file.webViewLink, lowConfidence: validated.lowConfidence, notInCrm: match.notInCrm, promptVersion: prompts.version });
  const rec = normalised.record || {};
  // A re-run that now matches a different company (e.g. a .match.json after a done run) gets a new note on the
  // new company; the old note is left where it was for a person to delete (the key cannot delete notes).
  const sameCompany = !rec.company_id || rec.company_id === match.companyId;
  const noteId = rec.note_id && sameCompany ? rec.note_id : null;
  return noteId
    ? { mode: 'update', noteId, body: NOTE.updateNoteBody({ html }) }
    : { mode: 'create', noteId: null, body: NOTE.createNoteBody({ html, timestampIso: nowIso, ownerId: cfg.hubspotOwnerId, companyId: match.companyId, dealId: match.dealId }) };
}

function buildDraft({ normalised, validated, cfg, nowIso }) {
  const draft = E.buildDraft({ ex: validated.ex, headerEmails: normalised.headerEmails, ownDomains: cfg.ownDomains, fallbackDate: normalised.fallbackDate || nowIso.slice(0, 10), fromAddress: cfg.fromAddress });
  const draftId = normalised.record && normalised.record.draft_id ? normalised.record.draft_id : null;
  if (!draft.to.length) return { mode: 'none', draftId, draft };
  return draftId ? { mode: 'update', draftId, draft, body: E.updateDraftBody({ draftId, draft }) } : { mode: 'create', draftId: null, draft };
}

// Finish: what happened this execution → folder move, sidecar, ledger row, whether to chain to the next file.
// s: { planned, normalised, collected?, validated?, match?, noteResult?, draftResult?, failure? , cfg, prompts, nowIso, startedIso }
function finish(s) {
  const { cfg, prompts, nowIso } = s;
  const n = s.normalised || {};
  const v = s.validated || null;
  const file = n.file || s.planned.file;
  let status;
  let reason;
  let detail = '';
  if (s.failure) { status = 'failed'; reason = s.failure.reason; detail = s.failure.detail || ''; }
  else if (n.route === 'wait') { status = 'waiting'; reason = n.reason; detail = n.detail; }
  else if (n.route === 'review') { status = 'review'; reason = n.reason; detail = n.detail; }
  else if (s.collected && s.collected.failed) { status = 'review'; reason = 'schema'; detail = s.collected.failed.detail; }
  else if (v && !v.ok) { status = 'review'; reason = v.reason; detail = v.detail; }
  else if (s.match && !s.match.matched) { status = 'review'; reason = 'unmatched'; detail = 'no single company matched'; }
  else if (v && v.lowConfidence) { status = 'review'; reason = 'low_confidence'; detail = `confidence.summary ${v.ex.confidence.summary}`; }
  else { status = 'done'; reason = ''; }

  const usage = v ? v.usage : (s.collected ? s.collected.usage : { input_tokens: 0, output_tokens: 0 });
  const calls = v ? v.calls : (s.collected ? s.collected.calls : (s.failure && s.failure.calls) || 0);
  const rec = n.record || {};
  const noteId = (s.noteResult && s.noteResult.id) || rec.note_id || '';
  const draftId = (s.draftResult && s.draftResult.id) || rec.draft_id || '';
  const draftState = s.draftResult ? s.draftResult.state : (s.match && s.match.matched && !s.failure ? 'skipped' : '');
  // The file was claimed into Processing at the start of the run (so overlapping runs cannot take it too).
  const target = status === 'waiting' ? cfg.inboxFolderId : (status === 'done' ? cfg.processedFolderId : cfg.needsReviewFolderId);
  const needsSidecar = status === 'review' || status === 'failed';
  const raw = (s.collected && s.collected.failed && s.collected.failed.raw) || (v && v.raw) || null;
  const sidecar = needsSidecar ? R.buildSidecar({
    fileName: file.name, fileId: file.id, reason, detail, rawOutput: raw, candidates: s.match ? s.match.candidates : [],
    ex: v && v.ex ? v.ex : null, promptVersion: prompts.version, misses: v ? v.misses : [], flags: v ? v.flags : [], processedAt: nowIso,
  }) : null;
  const cost = v ? v.cost : null;
  const row = L.buildRow({
    file_id: file.id, content_hash: n.hash || '', status, reason, match_rule: s.match ? s.match.rule : '',
    company_id: s.match && s.match.companyId ? s.match.companyId : (rec.company_id || ''), deal_id: s.match && s.match.dealId ? s.match.dealId : (rec.deal_id || ''),
    note_id: noteId, draft_id: draftId, draft_state: draftState,
    prompt_version: calls ? prompts.version : (rec.prompt_version || ''), model: calls ? cfg.model : (rec.model || ''), model_calls: calls,
    input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cost_usd: cost === null || cost === undefined ? '' : cost,
    runtime_s: s.startedIso ? Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(s.startedIso)) / 1000)) : '',
    override: n.override ? 'match.json' : '', processed_at: nowIso,
  });
  return {
    status, reason, detail,
    move: { fileId: file.id, to: target, from: cfg.processingFolderId },
    moveOverride: status !== 'waiting' && n.overrideFile ? { fileId: n.overrideFile.id, to: target, from: cfg.inboxFolderId } : null,
    sidecar: sidecar ? { name: R.sidecarName(file.name), body: R.multipartUpload({ name: R.sidecarName(file.name), parentId: cfg.needsReviewFolderId, json: sidecar }), json: sidecar } : null,
    ledger: L.upsertCall({ sheetId: cfg.ledgerSheetId, tab: cfg.ledgerTab, rowNumber: rec.rowNumber || null, row }),
    row,
    chain: (status !== 'waiting' || reason === 'token_ceiling') && (s.planned.remaining || 0) > 0,
  };
}

module.exports = { plan, normalise, collect, validate, planSearches, decide, buildNote, buildDraft, finish, toText, sha256, GDOC };
