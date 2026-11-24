'use strict';
// Generates workflow.json (the n8n export) from src/*.js, prompts/ and config/config.template.json.
// The logic lives in src/ (unit-tested); this script inlines it into the Code nodes, the N1 build_phase2.py
// pattern, so tests and workflow cannot drift. test/workflow.test.js fails if workflow.json is stale.
// Usage: node scripts/build-workflow.js           (write workflow.json)
//        node scripts/build-workflow.js --check   (exit 1 if workflow.json is out of date)
const fs = require('fs');
const path = require('path');
const { loadPrompts } = require('../src/prompts');

const ROOT = path.join(__dirname, '..');
const WORKFLOW_ID = 'n7MeetingFollowUp';
const MODULES = ['normalize', 'docx', 'schema', 'extract', 'checks', 'match', 'note', 'email', 'ledger', 'spend', 'review', 'steps'];

// Credentials: names from the PRD kickoff; ids are placeholders that n8n asks you to map on import.
const CRED = {
  drive: { googleDriveOAuth2Api: { id: 'map-on-import-google-drive-lab', name: 'google-drive-lab' } },
  gmail: { gmailOAuth2: { id: 'map-on-import-gmail-lab', name: 'gmail-lab' } },
  hubspot: { hubspotAppToken: { id: 'map-on-import-hubspot-demo', name: 'hubspot-demo' } },
  anthropic: { anthropicApi: { id: 'map-on-import-anthropic-lab', name: 'anthropic-lab' } },
};
const CRED_TYPE = { drive: 'googleDriveOAuth2Api', gmail: 'gmailOAuth2', hubspot: 'hubspotAppToken', anthropic: 'anthropicApi' };
const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 3000, onError: 'continueRegularOutput' };

function bundle() {
  let out = "const __nodeRequire = require;\nconst __lib = {};\n";
  out += "const __load = (name, fn) => { const module = { exports: {} }; fn(module, module.exports, (p) => (p.startsWith('./') ? __lib[p] : __nodeRequire(p))); __lib['./' + name] = module.exports; };\n";
  for (const m of MODULES) {
    const src = fs.readFileSync(path.join(ROOT, 'src', `${m}.js`), 'utf8');
    out += `__load('${m}', function (module, exports, require) {\n${src}\n});\n`;
  }
  return out + "const M = { steps: __lib['./steps'], review: __lib['./review'] };\n";
}

function build() {
  const prompts = loadPrompts(ROOT);
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/config.template.json'), 'utf8'));
  const LIB = bundle();
  const PROMPTS = `const PROMPTS = ${JSON.stringify({ version: prompts.version, reduceVersion: prompts.reduceVersion, extract: prompts.extract, reduce: prompts.reduce, schema: prompts.schema })};\n`;
  const META = `const PROMPTS = ${JSON.stringify({ version: prompts.version })};\n`;

  const nodes = [];
  const connections = {};
  const add = (n) => { nodes.push(n); return n.name; };
  const node = (name, type, typeVersion, position, parameters, extra = {}) => add({ parameters, name, type, typeVersion, position, ...extra });
  const code = (name, position, body, { prompts: withPrompts = false, lib = true } = {}) =>
    node(name, 'n8n-nodes-base.code', 2, position, { jsCode: (lib ? LIB + (withPrompts ? PROMPTS : META) : '') + body.trim() + '\n' });
  const link = (from, to, out = 0) => {
    connections[from] = connections[from] || { main: [] };
    while (connections[from].main.length <= out) connections[from].main.push([]);
    connections[from].main[out].push({ node: to, type: 'main', index: 0 });
  };
  const ifNode = (name, position, expr) => node(name, 'n8n-nodes-base.if', 2.2, position, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: `${name.replace(/\W/g, '')}-c1`, leftValue: expr, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and',
    },
    looseTypeValidation: true,
    options: {},
  });
  const http = (name, position, cred, { method = 'GET', url, query, headers, json, raw, rawType, response } = {}, extra = {}) => {
    const p = { method, url, authentication: 'predefinedCredentialType', nodeCredentialType: CRED_TYPE[cred] };
    if (query) { p.sendQuery = true; p.queryParameters = { parameters: Object.entries(query).map(([name, value]) => ({ name, value })) }; }
    if (headers) { p.sendHeaders = true; p.headerParameters = { parameters: Object.entries(headers).map(([name, value]) => ({ name, value })) }; }
    if (json) { p.sendBody = true; p.specifyBody = 'json'; p.jsonBody = json; }
    if (raw) { p.sendBody = true; p.contentType = 'raw'; p.rawContentType = rawType; p.body = raw; }
    p.options = response ? { response: { response } } : {};
    return node(name, 'n8n-nodes-base.httpRequest', 4.2, position, p, { credentials: CRED[cred], ...RETRY, ...extra });
  };
  const hubspotSearch = (name, position, object, key) => http(name, position, 'hubspot', {
    method: 'POST', url: `https://api.hubapi.com/crm/v3/objects/${object}/search`, json: `={{ JSON.stringify($('Plan searches').first().json.${key}) }}`,
  });

  // ---------------- triggers and config
  node('Every 5 minutes', 'n8n-nodes-base.scheduleTrigger', 1.2, [-1400, -200], { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } });
  node('Run manually', 'n8n-nodes-base.manualTrigger', 1, [-1400, 0], {});
  node('Next file', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, [-1400, 200], { inputSource: 'passthrough' });
  node('On error', 'n8n-nodes-base.errorTrigger', 1, [-1400, 400], {});
  code('config', [-1180, 100], `
// THE ONLY ACCOUNT-SPECIFIC NODE (PRD D-05). Fill in the REPLACE_WITH_ values; see docs/SETUP.md for each field.
const cfg = ${JSON.stringify(cfg, null, 2)};
const t = $input.first()?.json ?? {};
const isError = !!(t.execution && t.workflow);
return [{ json: { ...cfg, _startedIso: new Date().toISOString(), _isError: isError, _error: isError ? t : null } }];
`, { lib: false });
  for (const t of ['Every 5 minutes', 'Run manually', 'Next file', 'On error']) link(t, 'config');
  ifNode('Error run?', [-960, 100], "={{ $json._isError }}");
  link('config', 'Error run?');

  // ---------------- error path (no email: the alert is a sheet row plus an optional webhook)
  code('Shape error', [-740, 500], `
const cfg = $('config').first().json;
const st = $getWorkflowStaticData('global');
const e = M.review.shapeError(cfg._error, st.lastAlertMs, Date.now());
if (e.send) st.lastAlertMs = Date.now();
return [{ json: { ...e, alert: e.send && !!cfg.alertWebhookUrl } }];
`);
  http('Log error', [-520, 500], 'drive', {
    method: 'POST',
    url: "={{ 'https://sheets.googleapis.com/v4/spreadsheets/' + $('config').first().json.ledgerSheetId + '/values/' + encodeURIComponent($('config').first().json.errorsTab + '!A1:D1') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS' }}",
    json: "={{ JSON.stringify({ values: [$('Shape error').first().json.row] }) }}",
  });
  ifNode('Alert configured?', [-300, 500], "={{ $('Shape error').first().json.alert }}");
  node('Alert webhook', 'n8n-nodes-base.httpRequest', 4.2, [-80, 460], {
    method: 'POST', url: "={{ $('config').first().json.alertWebhookUrl }}", sendBody: true, specifyBody: 'json',
    jsonBody: "={{ JSON.stringify({ text: $('Shape error').first().json.text }) }}", options: {},
  }, { ...RETRY });
  link('Error run?', 'Shape error', 0);
  link('Shape error', 'Log error');
  link('Log error', 'Alert configured?');
  link('Alert configured?', 'Alert webhook', 0);

  // ---------------- plan
  http('List Inbox', [-740, 0], 'drive', {
    url: 'https://www.googleapis.com/drive/v3/files',
    query: {
      q: "={{ \"'\" + $('config').first().json.inboxFolderId + \"' in parents and trashed = false\" }}",
      fields: 'files(id,name,mimeType,createdTime,webViewLink)', orderBy: 'createdTime', pageSize: '200',
      supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
    },
  });
  http('Read ledger', [-520, 0], 'drive', {
    url: "={{ 'https://sheets.googleapis.com/v4/spreadsheets/' + $('config').first().json.ledgerSheetId + '/values/' + encodeURIComponent($('config').first().json.ledgerTab + '!A:S') }}",
  });
  link('Error run?', 'List Inbox', 1);
  link('List Inbox', 'Read ledger');
  code('Plan', [-300, 0], `
const cfg = $('config').first().json;
const list = $('List Inbox').first().json;
const ledger = $('Read ledger').first().json;
if (list.error) throw new Error('Drive list failed: ' + JSON.stringify(list.error).slice(0, 300));
if (ledger.error) throw new Error('Ledger read failed (does the "' + cfg.ledgerTab + '" tab exist?): ' + JSON.stringify(ledger.error).slice(0, 300));
return [{ json: M.steps.plan({ cfg, listing: list.files || [], ledgerValues: ledger.values || [], nowIso: cfg._startedIso }) }];
`);
  link('Read ledger', 'Plan');
  ifNode('Anything to process?', [-80, 0], "={{ $json.action === 'process' }}");
  link('Plan', 'Anything to process?');
  node('Nothing to do', 'n8n-nodes-base.noOp', 1, [140, 120], {});
  link('Anything to process?', 'Nothing to do', 1);

  // ---------------- fetch and normalise
  ifNode('Has .match.json?', [140, -100], "={{ !!$('Plan').first().json.override }}");
  link('Anything to process?', 'Has .match.json?', 0);
  http('Download override', [360, -200], 'drive', { url: "={{ $('Plan').first().json.override.url }}", response: { responseFormat: 'text' } });
  http('Download transcript', [580, -100], 'drive', { url: "={{ $('Plan').first().json.downloadUrl }}", response: { responseFormat: 'file' } });
  link('Has .match.json?', 'Download override', 0);
  link('Has .match.json?', 'Download transcript', 1);
  link('Download override', 'Download transcript');
  code('Normalise', [800, -100], `
const cfg = $('config').first().json;
const planned = $('Plan').first().json;
const dl = $input.first();
if (dl.json && dl.json.error) throw new Error('Drive download failed: ' + JSON.stringify(dl.json.error).slice(0, 300));
const buffer = await this.helpers.getBinaryDataBuffer(0, 'data');
let overrideJson = null;
if ($('Download override').isExecuted) {
  const o = $('Download override').first().json;
  if (o.error) throw new Error('Drive download of .match.json failed: ' + JSON.stringify(o.error).slice(0, 300));
  overrideJson = typeof o.data === 'string' ? o.data : JSON.stringify(o.data ?? o);
}
return [{ json: M.steps.normalise({ cfg, planned, buffer, overrideJson, ledgerValues: $('Read ledger').first().json.values || [], prompts: PROMPTS }) }];
`, { prompts: true });
  link('Download transcript', 'Normalise');

  // ---------------- extract (one call, or map over chunks then reduce)
  ifNode('Extract?', [1020, -100], "={{ $json.route === 'extract' }}");
  link('Normalise', 'Extract?');
  code('Split requests', [1240, -200], `
return $('Normalise').first().json.requests.map((r) => ({ json: r }));
`, { lib: false });
  link('Extract?', 'Split requests', 0);
  const anthropic = { url: 'https://api.anthropic.com/v1/messages', method: 'POST', headers: { 'anthropic-version': '2023-06-01' } };
  http('Model call', [1460, -200], 'anthropic', { ...anthropic, json: '={{ JSON.stringify($json) }}' }, { maxTries: 3, waitBetweenTries: 5000 });
  link('Split requests', 'Model call');
  code('Collect', [1680, -200], `
const cfg = $('config').first().json;
const responses = $input.all().map((i) => i.json);
const failed = responses.find((r) => r && r.error && !r.content);
if (failed) return [{ json: { modelError: String(failed.error.message ?? JSON.stringify(failed.error)).slice(0, 300), calls: responses.length } }];
return [{ json: M.steps.collect({ responses, cfg, prompts: PROMPTS }) }];
`, { prompts: true });
  link('Model call', 'Collect');
  ifNode('Reduce?', [1900, -200], '={{ $json.needReduce === true }}');
  link('Collect', 'Reduce?');
  http('Reduce call', [2120, -300], 'anthropic', { ...anthropic, json: "={{ JSON.stringify($('Collect').first().json.reduceRequest) }}" }, { maxTries: 3, waitBetweenTries: 5000 });
  link('Reduce?', 'Reduce call', 0);
  code('Validate', [2340, -200], `
const cfg = $('config').first().json;
const c = $('Collect').first().json;
if (c.modelError || c.failed) return [{ json: { skipped: true, ok: false } }];
let api = c.final;
if ($('Reduce call').isExecuted) {
  api = $('Reduce call').first().json;
  if (api.error && !api.content) return [{ json: { skipped: true, ok: false, modelError: String(api.error.message ?? JSON.stringify(api.error)).slice(0, 300), calls: c.calls } }];
}
return [{ json: M.steps.validate({ api, mapUsage: c.usage, calls: c.calls, transcript: $('Normalise').first().json.text, cfg }) }];
`);
  link('Reduce call', 'Validate');
  link('Reduce?', 'Validate', 1);

  // ---------------- match (PRD §2)
  ifNode('Extracted?', [2560, -200], '={{ $json.ok === true }}');
  link('Validate', 'Extracted?');
  code('Plan searches', [2780, -300], `
const cfg = $('config').first().json;
return [{ json: M.steps.planSearches({ normalised: $('Normalise').first().json, validated: $('Validate').first().json, cfg }) }];
`);
  link('Extracted?', 'Plan searches', 0);
  hubspotSearch('Search by domain', [3000, -300], 'companies', 'domainSearch');
  hubspotSearch('Search deals', [3220, -300], 'deals', 'dealSearch');
  ifNode('One deal?', [3440, -300], "={{ ($('Search deals').first().json.results || []).length === 1 }}");
  http('Deal companies', [3660, -400], 'hubspot', { url: "={{ 'https://api.hubapi.com/crm/v4/objects/deals/' + $('Search deals').first().json.results[0].id + '/associations/companies' }}" });
  hubspotSearch('Search by name', [3880, -300], 'companies', 'nameSearch');
  hubspotSearch('Search contacts', [4100, -300], 'contacts', 'contactSearch');
  link('Plan searches', 'Search by domain');
  link('Search by domain', 'Search deals');
  link('Search deals', 'One deal?');
  link('One deal?', 'Deal companies', 0);
  link('One deal?', 'Search by name', 1);
  link('Deal companies', 'Search by name');
  link('Search by name', 'Search contacts');
  code('Decide match', [4320, -300], `
const cfg = $('config').first().json;
const get = (n) => ($(n).isExecuted ? $(n).first().json : null);
const results = { domainRes: get('Search by domain'), dealRes: get('Search deals'), dealAssoc: get('Deal companies'), nameRes: get('Search by name'), contactRes: get('Search contacts') };
const bad = Object.entries(results).find(([, r]) => r && r.error);
if (bad) return [{ json: { matched: false, failure: { reason: 'hubspot_error', detail: bad[0] + ': ' + String(bad[1].error.message ?? JSON.stringify(bad[1].error)).slice(0, 300) } } }];
return [{ json: M.steps.decide({ normalised: $('Normalise').first().json, validated: $('Validate').first().json, ...results, cfg }) }];
`);
  link('Search contacts', 'Decide match');

  // ---------------- write the note (the only CRM write)
  ifNode('Matched?', [4540, -300], '={{ $json.matched === true }}');
  link('Decide match', 'Matched?');
  code('Build note', [4760, -400], `
const cfg = $('config').first().json;
return [{ json: M.steps.buildNote({ normalised: $('Normalise').first().json, validated: $('Validate').first().json, match: $('Decide match').first().json, cfg, prompts: PROMPTS, nowIso: new Date().toISOString() }) }];
`);
  link('Matched?', 'Build note', 0);
  ifNode('Note exists?', [4980, -400], "={{ $json.mode === 'update' }}");
  link('Build note', 'Note exists?');
  http('Update note', [5200, -500], 'hubspot', { method: 'PATCH', url: "={{ 'https://api.hubapi.com/crm/v3/objects/notes/' + $('Build note').first().json.noteId }}", json: "={{ JSON.stringify($('Build note').first().json.body) }}" });
  http('Create note', [5200, -300], 'hubspot', { method: 'POST', url: 'https://api.hubapi.com/crm/v3/objects/notes', json: "={{ JSON.stringify($('Build note').first().json.body) }}" });
  link('Note exists?', 'Update note', 0);
  link('Note exists?', 'Create note', 1);

  // ---------------- draft the follow-up (Create draft only; there is no send node)
  code('Build draft', [5420, -400], `
const cfg = $('config').first().json;
const noteNode = $('Update note').isExecuted ? 'Update note' : 'Create note';
const r = $(noteNode).first().json;
if (r.error) return [{ json: { mode: 'skip', failure: { reason: 'hubspot_error', detail: noteNode + ': ' + String(r.error.message ?? JSON.stringify(r.error)).slice(0, 300) } } }];
return [{ json: M.steps.buildDraft({ normalised: $('Normalise').first().json, validated: $('Validate').first().json, cfg, nowIso: new Date().toISOString() }) }];
`);
  link('Update note', 'Build draft');
  link('Create note', 'Build draft');
  ifNode('Draft to write?', [5640, -400], "={{ $json.mode === 'create' || $json.mode === 'update' }}");
  link('Build draft', 'Draft to write?');
  ifNode('Draft exists?', [5860, -500], "={{ $json.mode === 'update' }}");
  link('Draft to write?', 'Draft exists?', 0);
  http('Update draft', [6080, -600], 'gmail', {
    method: 'PUT', url: "={{ 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/' + $('Build draft').first().json.draftId }}",
    json: "={{ JSON.stringify($('Build draft').first().json.body) }}", response: { neverError: true, fullResponse: true },
  });
  node('Create draft', 'n8n-nodes-base.gmail', 2.1, [6080, -400], {
    resource: 'draft',
    operation: 'create',
    subject: "={{ $('Build draft').first().json.draft.subject }}",
    emailType: 'text',
    message: "={{ $('Build draft').first().json.draft.body }}",
    options: { sendTo: "={{ $('Build draft').first().json.draft.sendTo }}" },
  }, { credentials: CRED.gmail, ...RETRY });
  link('Draft exists?', 'Update draft', 0);
  link('Draft exists?', 'Create draft', 1);

  // ---------------- finish: sidecar, move, ledger row, next file
  code('Finish', [6300, 0], `
const cfg = $('config').first().json;
const ran = (n) => $(n).isExecuted;
const one = (n) => $(n).first().json;
const errText = (e) => String(e?.message ?? JSON.stringify(e)).slice(0, 300);
const s = { cfg, prompts: PROMPTS, nowIso: new Date().toISOString(), startedIso: cfg._startedIso, planned: one('Plan') };
if (ran('Normalise')) s.normalised = one('Normalise');
if (ran('Collect')) {
  const c = one('Collect');
  if (c.modelError) s.failure = { reason: 'model_error', detail: c.modelError, calls: c.calls };
  else s.collected = c;
}
if (ran('Validate')) {
  const v = one('Validate');
  if (v.modelError) s.failure = { reason: 'model_error', detail: v.modelError, calls: v.calls };
  else if (!v.skipped) s.validated = v;
}
if (ran('Decide match')) {
  const d = one('Decide match');
  if (d.failure) s.failure = d.failure; else s.match = d;
}
for (const n of ['Create note', 'Update note']) {
  if (!ran(n)) continue;
  const r = one(n);
  if (r.error) s.failure = { reason: 'hubspot_error', detail: n + ': ' + errText(r.error) };
  else s.noteResult = { id: String(r.id) };
}
if (ran('Build draft')) {
  const b = one('Build draft');
  if (b.mode === 'none') s.draftResult = { id: b.draftId || '', state: 'no_recipients' };
  if (ran('Create draft')) {
    const r = one('Create draft');
    if (r.error) s.failure = { reason: 'gmail_error', detail: 'Create draft: ' + errText(r.error) };
    else s.draftResult = { id: String(r.id), state: 'created' };
  }
  if (ran('Update draft')) {
    const r = one('Update draft');
    const code = Number(r.statusCode);
    if (code === 404) s.draftResult = { id: b.draftId, state: 'gone' };
    else if (code >= 200 && code < 300) s.draftResult = { id: b.draftId, state: 'updated' };
    else s.failure = { reason: 'gmail_error', detail: 'Update draft: HTTP ' + code };
  }
}
return [{ json: M.steps.finish(s) }];
`);
  for (const [from, out] of [['Extract?', 1], ['Extracted?', 1], ['Matched?', 1], ['Draft to write?', 1], ['Update draft', 0], ['Create draft', 0]]) link(from, 'Finish', out);
  ifNode('Sidecar?', [6520, 0], "={{ !!$('Finish').first().json.sidecar }}");
  link('Finish', 'Sidecar?');
  http('Upload sidecar', [6740, -100], 'drive', {
    method: 'POST', url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
    raw: "={{ $('Finish').first().json.sidecar.body }}", rawType: 'multipart/related; boundary=n7-review-boundary',
  }, { onError: 'stopWorkflow' });
  link('Sidecar?', 'Upload sidecar', 0);
  ifNode('Move?', [6960, 0], "={{ !!$('Finish').first().json.move }}");
  link('Sidecar?', 'Move?', 1);
  link('Upload sidecar', 'Move?');
  const move = (key) => ({
    method: 'PATCH',
    url: `={{ 'https://www.googleapis.com/drive/v3/files/' + $('Finish').first().json.${key}.fileId + '?supportsAllDrives=true&addParents=' + $('Finish').first().json.${key}.to + '&removeParents=' + $('Finish').first().json.${key}.from }}`,
    json: '={{ JSON.stringify({}) }}',
  });
  http('Move transcript', [7180, -100], 'drive', move('move'), { onError: 'stopWorkflow' });
  link('Move?', 'Move transcript', 0);
  ifNode('Move .match.json?', [7400, -100], "={{ !!$('Finish').first().json.moveOverride }}");
  link('Move transcript', 'Move .match.json?');
  http('Move override', [7620, -200], 'drive', move('moveOverride'), { onError: 'stopWorkflow' });
  link('Move .match.json?', 'Move override', 0);
  http('Write ledger', [7840, 0], 'drive', {
    method: "={{ $('Finish').first().json.ledger.method }}", url: "={{ $('Finish').first().json.ledger.url }}",
    json: "={{ JSON.stringify($('Finish').first().json.ledger.body) }}",
  }, { onError: 'stopWorkflow' });
  link('Move?', 'Write ledger', 1);
  link('Move .match.json?', 'Write ledger', 1);
  link('Move override', 'Write ledger');
  ifNode('More files?', [8060, 0], "={{ $('Finish').first().json.chain === true }}");
  link('Write ledger', 'More files?');
  node('Process next file', 'n8n-nodes-base.executeWorkflow', 1.2, [8280, -100], {
    source: 'database', workflowId: { __rl: true, mode: 'id', value: '={{ $workflow.id }}' }, mode: 'once',
    options: { waitForSubWorkflow: false },
  });
  link('More files?', 'Process next file', 0);
  node('Run complete', 'n8n-nodes-base.noOp', 1, [8280, 100], {});
  link('More files?', 'Run complete', 1);

  return {
    id: WORKFLOW_ID,
    name: 'N7 Meeting Follow-Up',
    nodes,
    connections,
    active: false,
    settings: {
      executionOrder: 'v1',
      errorWorkflow: WORKFLOW_ID,
      saveDataSuccessExecution: 'none',
      saveDataErrorExecution: 'all',
      saveManualExecutions: true,
      callerPolicy: 'workflowsFromSameOwner',
    },
    pinData: {},
    meta: { promptVersion: prompts.version, reducePromptVersion: prompts.reduceVersion, builtBy: 'scripts/build-workflow.js' },
    tags: [],
  };
}

if (require.main === module) {
  const out = JSON.stringify(build(), null, 2) + '\n';
  const file = path.join(ROOT, 'workflow.json');
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (process.argv.includes('--check')) {
    if (cur !== out) { console.error('workflow.json is out of date: run npm run build'); process.exit(1); }
    console.log('workflow.json: up to date');
  } else {
    fs.writeFileSync(file, out);
    console.log(`workflow.json: ${cur === out ? 'unchanged' : 'written'}`);
  }
}

module.exports = { build, WORKFLOW_ID, MODULES };
