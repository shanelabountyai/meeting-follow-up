'use strict';
// Structure of workflow.json, and runs of the exported workflow itself through test/n8n-sim.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const sim = require('./n8n-sim');
const { FIXTURES } = require('../fixtures/spec');
const { MODULES } = require('../scripts/build-workflow');

const wf = JSON.parse(fs.readFileSync(path.join(H.ROOT, 'workflow.json'), 'utf8'));
const TRIGGERS = ['n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.manualTrigger', 'n8n-nodes-base.executeWorkflowTrigger', 'n8n-nodes-base.errorTrigger'];
const names = new Set(wf.nodes.map((n) => n.name));

test('workflow.json is a valid n8n export: nodes, connections, settings; inactive; unique names', () => {
  assert.ok(Array.isArray(wf.nodes) && wf.nodes.length > 0);
  assert.strictEqual(typeof wf.connections, 'object');
  assert.strictEqual(wf.settings.executionOrder, 'v1');
  assert.strictEqual(wf.active, false, 'ships inactive; Shane turns the schedule on');
  assert.strictEqual(names.size, wf.nodes.length);
  for (const n of wf.nodes) {
    assert.ok(n.name && n.type && typeof n.typeVersion === 'number' && Array.isArray(n.position) && n.parameters, n.name);
  }
  assert.strictEqual(wf.settings.errorWorkflow, wf.id, 'the workflow is its own error workflow');
});

test('every node is connected: each connection target exists, every non-trigger has an input, every node is reachable from a trigger', () => {
  const incoming = new Map();
  for (const [from, c] of Object.entries(wf.connections)) {
    assert.ok(names.has(from), `connection from unknown node ${from}`);
    for (const out of c.main) for (const l of out) {
      assert.ok(names.has(l.node), `connection to unknown node ${l.node}`);
      incoming.set(l.node, (incoming.get(l.node) || 0) + 1);
    }
  }
  const triggers = wf.nodes.filter((n) => TRIGGERS.includes(n.type)).map((n) => n.name);
  assert.strictEqual(triggers.length, 4);
  for (const n of wf.nodes) if (!TRIGGERS.includes(n.type)) assert.ok(incoming.get(n.name), `${n.name} has no input`);
  const seen = new Set(triggers);
  const stack = [...triggers];
  while (stack.length) for (const out of (wf.connections[stack.pop()] || { main: [] }).main) for (const l of out) if (!seen.has(l.node)) { seen.add(l.node); stack.push(l.node); }
  assert.deepStrictEqual(wf.nodes.map((n) => n.name).filter((n) => !seen.has(n)), []);
  for (const n of wf.nodes) {
    const outs = (wf.connections[n.name] || { main: [] }).main.flat().length;
    const terminal = ['Nothing to do', 'Run complete', 'Process next file', 'Alert webhook'].includes(n.name);
    if (!terminal) assert.ok(outs > 0, `${n.name} is a dead end`);
  }
});

test('no node can send email: the only Gmail node is draft/create; no send-capable node types or endpoints', () => {
  const gmail = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.gmail');
  assert.deepStrictEqual(gmail.map((n) => [n.parameters.resource, n.parameters.operation]), [['draft', 'create']]);
  for (const n of wf.nodes) {
    assert.doesNotMatch(n.type, /emailSend|smtp|sendGrid|sendgrid|mailgun|mailjet|microsoftOutlook|mandrill|sendInBlue|brevo|postmark|ses/i, n.name);
    const p = JSON.stringify(n.parameters);
    if (n.type === 'n8n-nodes-base.httpRequest') {
      assert.doesNotMatch(String(n.parameters.url), /\/send\b|messages\/send|drafts\/send|:send/i, `${n.name} url`);
      if (/gmail\.googleapis\.com/.test(p)) assert.match(String(n.parameters.method), /^PUT$/, 'the only Gmail HTTP call is drafts.update');
    }
    if (n.type === 'n8n-nodes-base.code') assert.doesNotMatch(n.parameters.jsCode, /\/send\b|messages\/send|drafts\/send/i, `${n.name} code`);
  }
});

test('HubSpot rail: only searches, the deal→company association read, and notes create/update', () => {
  const allowed = [/^https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/(companies|deals|contacts)\/search$/, /^https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/notes$/, /crm\/v3\/objects\/notes\/' \+/, /crm\/v4\/objects\/deals\/' \+ .* \+ '\/associations\/companies'/];
  const hub = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest' && n.parameters.nodeCredentialType === 'hubspotAppToken');
  assert.strictEqual(hub.length, 7);
  for (const n of hub) assert.ok(allowed.some((re) => re.test(n.parameters.url)), `${n.name}: ${n.parameters.url}`);
  for (const n of hub.filter((x) => /search$/.test(x.parameters.url))) assert.strictEqual(n.parameters.method, 'POST');
  for (const n of wf.nodes) assert.doesNotMatch(n.type, /hubspot/i, 'no HubSpot node: every call is an inspectable HTTP request');
});

test('credentials: four placeholders, mapped on import; no secret-looking values anywhere', () => {
  const creds = new Map();
  for (const n of wf.nodes) for (const [type, c] of Object.entries(n.credentials || {})) creds.set(c.name, { type, id: c.id });
  assert.deepStrictEqual([...creds.keys()].sort(), ['anthropic-lab', 'gmail-lab', 'google-drive-lab', 'hubspot-demo']);
  for (const { id } of creds.values()) assert.match(id, /^map-on-import-/);
  const raw = JSON.stringify(wf);
  assert.doesNotMatch(raw, /sk-ant-|pat-na1-|AIza[0-9A-Za-z_-]{20}|ya29\.|xox[bp]-/);
});

test('config is the only account-specific node: REPLACE_WITH_ values appear only there', () => {
  const holders = wf.nodes.filter((n) => JSON.stringify(n.parameters).includes('REPLACE_WITH_')).map((n) => n.name);
  assert.deepStrictEqual(holders, ['config']);
  const tpl = require('../config/config.template.json');
  for (const k of Object.keys(tpl)) assert.ok(wf.nodes.find((n) => n.name === 'config').parameters.jsCode.includes(`"${k}"`), k);
});

test('Code nodes inline the current src/ modules and prompt version; all compile', () => {
  for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
    assert.doesNotThrow(() => new Function('$', '$input', '$getWorkflowStaticData', 'require', '$workflow', `return (async function () {\n${n.parameters.jsCode}\n});`), n.name);
    if (n.name === 'config' || n.name === 'Split requests') continue;
    for (const m of MODULES) assert.ok(n.parameters.jsCode.includes(fs.readFileSync(path.join(H.ROOT, 'src', `${m}.js`), 'utf8')), `${n.name} lacks current src/${m}.js`);
  }
  assert.strictEqual(wf.meta.promptVersion, 'extract-v0.1');
});

test('retries and error path: every external call retries 3 times; API failures route to Needs-Review, not a crash', () => {
  for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest' || x.type === 'n8n-nodes-base.gmail')) {
    assert.strictEqual(n.retryOnFail, true, n.name);
    assert.strictEqual(n.maxTries, 3, n.name);
  }
  for (const name of ['Model call', 'Reduce call', 'Search by domain', 'Create note', 'Create draft', 'Update draft']) {
    assert.strictEqual(wf.nodes.find((n) => n.name === name).onError, 'continueRegularOutput', name);
  }
});

// ---------------- the exported workflow, executed offline

function testWorkflow() {
  const w = JSON.parse(JSON.stringify(wf));
  const c = w.nodes.find((n) => n.name === 'config');
  c.parameters.jsCode = c.parameters.jsCode.replace(/const cfg = \{[\s\S]*?\n\};/, `const cfg = ${JSON.stringify(H.baseCfg)};`);
  return w;
}

for (const id of ['F01', 'F02', 'F03', 'F04', 'F05', 'F06']) {
  test(`workflow.json executed offline on ${id} gives the same result as the step harness`, async () => {
    const fx = FIXTURES.find((f) => f.id === id);
    const exp = JSON.parse(fs.readFileSync(path.join(H.ROOT, 'fixtures/expected', `${id}.expected.json`), 'utf8'));
    const env = H.env([H.transcriptFile(fx)]);
    const model = H.recordedModel([{ marker: fx.recorded.title, recorded: H.loadRecorded(id) }]);
    const r = await sim.run(testWorkflow(), 'Run manually', env, model);
    const fin = r.outputs.get('Finish')[0].json;
    assert.strictEqual(fin.status, exp.outcome);
    assert.strictEqual(fin.reason, exp.reason);
    assert.strictEqual(env.hubspot.notes.size, exp.outcome === 'done' ? 1 : 0);
    assert.strictEqual(env.gmail.drafts.size, exp.outcome === 'done' && exp.recipients.length ? 1 : 0);
    assert.strictEqual(env.sheet.values.length, 2);
    assert.ok(!r.services.log.some((l) => /send/i.test(l.path)), 'no send call made');
    if (id === 'F06') assert.strictEqual(model.calls.length, 3, 'two map calls and one reduce call');
  });
}

test('workflow.json offline: two files chain through "Process next file"; re-run updates, no duplicates', async () => {
  const fxs = [FIXTURES[0], FIXTURES[4]];
  const env = H.env(fxs.map((fx, i) => ({ ...H.transcriptFile(fx), createdTime: `2026-11-20T10:0${i}:00Z` })));
  const model = H.recordedModel(fxs.map((fx) => ({ marker: fx.recorded.title, recorded: H.loadRecorded(fx.id) })));
  const w = testWorkflow();
  const first = await sim.run(w, 'Run manually', env, model);
  assert.deepStrictEqual(first.chained, [w.id]);
  const second = await sim.run(w, 'Next file', env, model);
  assert.deepStrictEqual(second.chained, []);
  assert.strictEqual(env.hubspot.notes.size, 2);
  for (const f of [...env.drive.folders['fake-processed'].values()]) env.drive.move({ fileId: f.id, from: 'fake-processed', to: 'fake-inbox' });
  await sim.run(w, 'Run manually', env, model);
  await sim.run(w, 'Next file', env, model);
  assert.strictEqual(env.hubspot.notes.size, 2);
  assert.strictEqual(env.gmail.drafts.size, 2);
  assert.strictEqual(env.sheet.values.length, 3);
});

test('workflow.json offline: a HubSpot outage after retries sends the file to Needs-Review as hubspot_error', async () => {
  const fx = FIXTURES[0];
  const env = H.env([H.transcriptFile(fx)]);
  env.hubspot.createNote = () => { throw new Error('503 service unavailable'); };
  const model = H.recordedModel([{ marker: fx.recorded.title, recorded: H.loadRecorded(fx.id) }]);
  const r = await sim.run(testWorkflow(), 'Run manually', env, model);
  const fin = r.outputs.get('Finish')[0].json;
  assert.deepStrictEqual([fin.status, fin.reason], ['failed', 'hubspot_error']);
  assert.strictEqual(env.gmail.drafts.size, 0, 'no draft after a failed note');
  assert.ok(env.drive.folders['fake-needs-review'].has(`drive-${fx.id}`));
});

test('workflow.json offline: the error trigger writes an errors row and, when configured, one throttled webhook line', async () => {
  const env = H.env([]);
  env.alerts = [];
  env.alertUrl = 'https://hooks.example/n7';
  const w = testWorkflow();
  const c = w.nodes.find((n) => n.name === 'config');
  c.parameters.jsCode = c.parameters.jsCode.replace('"alertWebhookUrl":""', `"alertWebhookUrl":"${env.alertUrl}"`);
  const err = [{ json: { execution: { id: '42', lastNodeExecuted: 'Create note', error: { message: 'boom' } }, workflow: { id: w.id, name: w.name } } }];
  const staticData = {};
  await sim.run(w, 'On error', env, null, { triggerItems: err, staticData });
  await sim.run(w, 'On error', env, null, { triggerItems: err, staticData });
  assert.strictEqual(env.errors.length, 2, 'every failure is logged');
  assert.strictEqual(env.alerts.length, 1, 'second alert within 15 minutes is throttled');
  assert.match(env.alerts[0].text, /failed at "Create note"/);
});
