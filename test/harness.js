'use strict';
// Offline run of the workflow: the same src/steps.js functions the Code nodes call, in the order workflow.json
// wires them, against in-memory fakes of Drive, the ledger sheet, HubSpot and Gmail, with recorded model
// responses instead of a model call. The Gmail fake has drafts only: there is no send to call.
const fs = require('fs');
const path = require('path');
const steps = require('../src/steps');
const L = require('../src/ledger');
const { loadPrompts } = require('../src/prompts');

const ROOT = path.join(__dirname, '..');
const prompts = loadPrompts(ROOT);
const baseCfg = require('../fixtures/test-config.json');
const seed = require('../fixtures/hubspot-seed.json');

function fakeHubSpot(data = seed) {
  const notes = new Map();
  let nextNote = 5001;
  const calls = [];
  const eq = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
  // CRM search with OR-ed filterGroups of EQ filters, as planSearches() builds them.
  const search = (records, props) => (body) => {
    calls.push({ kind: 'search', body });
    const results = records.filter((r) => body.filterGroups.some((g) => g.filters.every((f) => f.operator === 'EQ' && eq(props(r)[f.propertyName], f.value))));
    return { total: results.length, results: results.map((r) => ({ id: r.id, properties: props(r) })) };
  };
  return {
    notes, calls,
    searchCompanies: search(data.companies, (c) => ({ name: c.name, domain: c.domain })),
    searchDeals: search(data.deals, (d) => ({ dealname: d.name })),
    searchContacts: search(data.contacts, (c) => ({ email: c.email })),
    dealCompanies: (dealId) => ({ results: (data.deals.find((d) => d.id === dealId)?.companyIds || []).map((id) => ({ toObjectId: Number(id) })) }),
    createNote: (body) => { const id = String(nextNote++); notes.set(id, body); calls.push({ kind: 'createNote', id }); return { id }; },
    updateNote: (id, body) => { if (!notes.has(id)) throw Object.assign(new Error('note not found'), { status: 404 }); notes.set(id, { ...notes.get(id), properties: { ...notes.get(id).properties, ...body.properties } }); calls.push({ kind: 'updateNote', id }); return { id }; },
  };
}

function fakeGmail() {
  const drafts = new Map();
  let next = 1;
  return {
    drafts,
    sent: [], // stays empty: nothing in the workflow can send
    createDraft: ({ sendTo, subject, message }) => { const id = `r-${next++}`; drafts.set(id, { sendTo, subject, message }); return { id, message: { id: `m-${id}` } }; },
    updateDraft: (id, body) => { if (!drafts.has(id)) return { status: 404 }; drafts.set(id, { ...drafts.get(id), raw: body.message.raw }); return { status: 200, id }; },
  };
}

function fakeDrive(files) {
  const folders = { 'fake-inbox': new Map(), 'fake-processing': new Map(), 'fake-processed': new Map(), 'fake-needs-review': new Map() };
  for (const f of files) folders['fake-inbox'].set(f.id, f);
  return {
    folders,
    list: (folder) => [...folders[folder].values()].map(({ id, name, mimeType, createdTime, webViewLink }) => ({ id, name, mimeType, createdTime, webViewLink })),
    download: (id) => { for (const m of Object.values(folders)) if (m.has(id)) return m.get(id).content; throw new Error('no file'); },
    move: ({ fileId, from, to }) => { const f = folders[from].get(fileId); folders[from].delete(fileId); folders[to].set(fileId, f); },
    upload: (folder, name, json) => { const id = `up-${name}`; folders[folder].set(id, { id, name, content: Buffer.from(JSON.stringify(json)), sidecar: json }); },
  };
}

function fakeSheet() {
  const values = [L.COLUMNS.slice()];
  return {
    values,
    apply: (call) => {
      const row = call.body.values[0];
      if (call.method === 'PUT') { const n = Number(/A(\d+):/.exec(decodeURIComponent(call.url))[1]); values[n - 1] = row; }
      else values.push(row);
    },
  };
}

const loadRecorded = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/recorded', `${id}.json`), 'utf8'));
const loadVariant = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/recorded/variants', `${id}.json`), 'utf8'));

function transcriptFile(fx, id = `drive-${fx.id}`) {
  const content = fs.readFileSync(path.join(ROOT, 'fixtures/transcripts', fx.file));
  return { id, name: fx.file, mimeType: fx.format === 'vtt' ? 'text/vtt' : 'text/plain', createdTime: '2026-11-20T10:00:00Z', webViewLink: `https://drive.google.com/file/d/${id}/view`, content };
}

// One workflow execution: processes one file, like workflow.json. `model(request)` returns a recorded response.
function runOnce(env, model, opts = {}) {
  const cfg = { ...baseCfg, ...(opts.cfg || {}) };
  const nowIso = opts.nowIso || '2026-11-24T16:00:00.000Z';
  const trace = [];
  const planned = steps.plan({ cfg, listing: env.drive.list(cfg.inboxFolderId), ledgerValues: env.sheet.values, nowIso });
  trace.push('plan:' + planned.action);
  if (planned.action !== 'process') return { planned, trace };
  env.drive.move(planned.claim);
  const overrideJson = planned.override ? env.drive.download(planned.override.id).toString('utf8') : null;
  const normalised = steps.normalise({ cfg, planned, buffer: env.drive.download(planned.file.id), overrideJson, ledgerValues: env.sheet.values, prompts });
  trace.push('normalise:' + normalised.route);
  const s = { planned, normalised, cfg, prompts, nowIso, startedIso: nowIso };
  if (normalised.route === 'extract') {
    const responses = normalised.requests.map((r) => model(r, 'map'));
    trace.push(`model:${responses.length}`);
    const collected = steps.collect({ responses, cfg, prompts });
    s.collected = collected;
    if (!collected.failed) {
      const api = collected.needReduce ? model(collected.reduceRequest, 'reduce') : collected.final;
      if (collected.needReduce) trace.push('model:reduce');
      const validated = steps.validate({ api, mapUsage: collected.usage, calls: collected.calls, transcript: normalised.text, cfg });
      s.validated = validated;
      trace.push('validate:' + (validated.ok ? 'ok' : validated.reason));
      if (validated.ok) {
        const q = steps.planSearches({ normalised, validated, cfg });
        const domainRes = env.hubspot.searchCompanies(q.domainSearch);
        const dealRes = env.hubspot.searchDeals(q.dealSearch);
        const dealAssoc = dealRes.results.length === 1 ? env.hubspot.dealCompanies(dealRes.results[0].id) : null;
        const nameRes = env.hubspot.searchCompanies(q.nameSearch);
        const contactRes = env.hubspot.searchContacts(q.contactSearch);
        const match = steps.decide({ normalised, validated, domainRes, dealRes, dealAssoc, nameRes, contactRes, cfg });
        s.match = match;
        trace.push('match:' + match.rule);
        if (match.matched) {
          const note = steps.buildNote({ normalised, validated, match, cfg, prompts, nowIso });
          s.noteResult = note.mode === 'update' ? env.hubspot.updateNote(note.noteId, note.body) : env.hubspot.createNote(note.body);
          trace.push('note:' + note.mode);
          const d = steps.buildDraft({ normalised, validated, cfg, nowIso });
          s.draft = d;
          if (d.mode === 'none') s.draftResult = { id: d.draftId || '', state: 'no_recipients' };
          else if (d.mode === 'update') {
            const r = env.gmail.updateDraft(d.draftId, d.body);
            s.draftResult = r.status === 404 ? { id: d.draftId, state: 'gone' } : { id: d.draftId, state: 'updated' };
          } else {
            const r = env.gmail.createDraft({ sendTo: d.draft.sendTo, subject: d.draft.subject, message: d.draft.body });
            s.draftResult = { id: r.id, state: 'created' };
          }
          trace.push('draft:' + s.draftResult.state);
        }
      }
    }
  }
  const fin = steps.finish(s);
  env.sheet.apply(fin.ledger);
  if (fin.sidecar) env.drive.upload(cfg.needsReviewFolderId, fin.sidecar.name, fin.sidecar.json);
  if (fin.move) env.drive.move(fin.move);
  if (fin.moveOverride) env.drive.move(fin.moveOverride);
  trace.push('finish:' + fin.status);
  return { planned, normalised, s, fin, trace };
}

// Runs executions until the Inbox is empty or the workflow stops chaining (as the "Next file" node would).
function runAll(env, model, opts = {}) {
  const runs = [];
  for (let i = 0; i < 50; i++) {
    const r = runOnce(env, model, opts);
    runs.push(r);
    if (!r.fin || !r.fin.chain) break;
  }
  return runs;
}

// A model stand-in answering from recorded responses. entries: [{ marker, recorded }] where marker is a string
// that appears in that fixture's transcript header (its title), so requests are routed without a model.
function recordedModel(entries) {
  const calls = [];
  const fn = (request, phase) => {
    const content = request.messages[0].content;
    const e = entries.find((x) => content.includes(x.marker));
    if (!e) throw new Error('no recorded response for this request');
    calls.push({ marker: e.marker, phase });
    if (phase === 'reduce') return e.recorded.reduce;
    const part = Number((/part="(\d+)"/.exec(content) || [])[1] || 1);
    return e.recorded.responses[part - 1];
  };
  fn.calls = calls;
  return fn;
}

function env(files) {
  return { drive: fakeDrive(files), sheet: fakeSheet(), hubspot: fakeHubSpot(), gmail: fakeGmail() };
}

module.exports = { env, runOnce, runAll, fakeHubSpot, fakeGmail, fakeDrive, fakeSheet, loadRecorded, loadVariant, transcriptFile, recordedModel, prompts, baseCfg, ROOT };
