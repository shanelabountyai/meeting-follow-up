'use strict';
// A small interpreter for workflow.json, so tests run the exported workflow itself (its Code node source, IF
// expressions, HTTP URLs and bodies, and its connections) against the in-memory fakes in harness.js.
// It models the n8n features this workflow uses and nothing more: Code (all-items mode), IF, HTTP Request,
// Gmail (draft create), NoOp, Execute Workflow and the four trigger types. It is not n8n; docs/ACCEPTANCE.md
// lists the import into a live n8n as not verified.

function evalExpr(v, ctx) {
  if (typeof v !== 'string' || !v.startsWith('=')) return v;
  const m = /^=\{\{([\s\S]*)\}\}$/.exec(v);
  if (!m) throw new Error(`unsupported expression: ${v.slice(0, 60)}`);
  return new Function('$', '$json', '$workflow', `return (${m[1]});`)(ctx.$, ctx.$json, ctx.$workflow);
}

function makeServices(env, model) {
  const log = [];
  const decodeUrl = (u) => new URL(u);
  return {
    log,
    request({ method, url, query, body, rawBody, responseFormat }) {
      const u = decodeUrl(url);
      if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
      log.push({ method, host: u.host, path: u.pathname });
      const p = u.pathname;
      // Google Drive
      if (u.host === 'www.googleapis.com' && p === '/drive/v3/files' && method === 'GET') {
        const folder = /'([^']+)' in parents/.exec(u.searchParams.get('q'))[1];
        return { json: { files: env.drive.list(folder) } };
      }
      let m = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(p);
      if (m && method === 'GET') {
        const content = env.drive.download(m[1]);
        if (responseFormat === 'file') return { json: {}, binary: { data: { buffer: Buffer.from(content) } } };
        return { json: { data: Buffer.from(content).toString('utf8') } };
      }
      if (m && method === 'PATCH') {
        env.drive.move({ fileId: m[1], to: u.searchParams.get('addParents'), from: u.searchParams.get('removeParents') });
        return { json: { id: m[1] } };
      }
      if (u.host === 'www.googleapis.com' && p === '/upload/drive/v3/files' && method === 'POST') {
        const parts = rawBody.split('--n7-review-boundary').map((s) => s.split('\r\n\r\n')[1]).filter(Boolean);
        const meta = JSON.parse(parts[0]);
        env.drive.upload(meta.parents[0], meta.name, JSON.parse(parts[1].replace(/\r\n$/, '')));
        return { json: { id: `up-${meta.name}` } };
      }
      // Google Sheets
      if (u.host === 'sheets.googleapis.com') {
        if (method === 'GET') return { json: { values: env.sheet.values } };
        if (p.includes(':append') && decodeURIComponent(p).includes('!A1:D1')) { (env.errors = env.errors || []).push(body.values[0]); return { json: {} }; }
        env.sheet.apply({ method, url: u.pathname, body });
        return { json: {} };
      }
      // HubSpot
      if (u.host === 'api.hubapi.com') {
        if (p === '/crm/v3/objects/companies/search') return { json: env.hubspot.searchCompanies(body) };
        if (p === '/crm/v3/objects/deals/search') return { json: env.hubspot.searchDeals(body) };
        if (p === '/crm/v3/objects/contacts/search') return { json: env.hubspot.searchContacts(body) };
        m = /^\/crm\/v4\/objects\/deals\/(\d+)\/associations\/companies$/.exec(p);
        if (m && method === 'GET') return { json: env.hubspot.dealCompanies(m[1]) };
        if (p === '/crm/v3/objects/notes' && method === 'POST') return { json: env.hubspot.createNote(body) };
        m = /^\/crm\/v3\/objects\/notes\/(\d+)$/.exec(p);
        if (m && method === 'PATCH') return { json: env.hubspot.updateNote(m[1], body) };
      }
      // Gmail (drafts only; a send endpoint does not exist in this fake)
      m = /^\/gmail\/v1\/users\/me\/drafts\/([^/]+)$/.exec(p);
      if (u.host === 'gmail.googleapis.com' && m && method === 'PUT') {
        const r = env.gmail.updateDraft(m[1], body);
        return { json: { statusCode: r.status, body: r } };
      }
      if (u.host === 'api.anthropic.com' && p === '/v1/messages') {
        const phase = body.messages[0].content.startsWith('<chunk_results>') ? 'reduce' : 'map';
        return { json: model(body, phase) };
      }
      if (env.alerts && url === env.alertUrl) { env.alerts.push(body); return { json: {} }; }
      throw new Error(`sim: no fake for ${method} ${url}`);
    },
  };
}

async function run(workflow, trigger, env, model, opts = {}) {
  const byName = new Map(workflow.nodes.map((n) => [n.name, n]));
  const outputs = new Map(); // node name -> items (last run)
  const order = [];
  const services = opts.services || makeServices(env, model);
  const staticData = opts.staticData || {};
  const chained = [];
  const $ = (name) => {
    if (!byName.has(name)) throw new Error(`sim: unknown node ${name}`);
    const items = outputs.get(name);
    return {
      isExecuted: outputs.has(name),
      first: () => { if (!items) throw new Error(`sim: ${name} has not run`); return items[0]; },
      all: () => items || [],
    };
  };
  const wrap$ = (name) => {
    const r = $(name);
    return { isExecuted: r.isExecuted, first: () => r.first(), all: () => r.all() };
  };
  const workflowCtx = { id: workflow.id };

  async function exec(node, input) {
    const p = node.parameters;
    const t = node.type;
    if (t.endsWith('Trigger') || t === 'n8n-nodes-base.manualTrigger' || t === 'n8n-nodes-base.errorTrigger') return [input || [{ json: {} }]];
    if (t === 'n8n-nodes-base.noOp') return [input];
    if (t === 'n8n-nodes-base.code') {
      const fn = new Function('$', '$input', '$getWorkflowStaticData', 'require', '$workflow', `return (async function () {\n${p.jsCode}\n}).call(this);`);
      const ctx = { helpers: { getBinaryDataBuffer: async (i, key) => input[i].binary[key].buffer } };
      const out = await fn.call(ctx, (n) => wrap$(n), { all: () => input, first: () => input[0] }, () => staticData, require, workflowCtx);
      return [out.map((o) => ({ json: o.json, binary: o.binary }))];
    }
    if (t === 'n8n-nodes-base.if') {
      const c = p.conditions.conditions[0];
      const v = evalExpr(c.leftValue, { $: (n) => wrap$(n), $json: input[0].json, $workflow: workflowCtx });
      return v ? [input, []] : [[], input];
    }
    if (t === 'n8n-nodes-base.httpRequest') {
      const results = [];
      for (const item of input) {
        const ctx = { $: (n) => wrap$(n), $json: item.json, $workflow: workflowCtx };
        const method = evalExpr(p.method, ctx);
        const url = evalExpr(p.url, ctx);
        const query = p.sendQuery ? Object.fromEntries(p.queryParameters.parameters.map((q) => [q.name, evalExpr(q.value, ctx)])) : null;
        const body = p.sendBody && p.specifyBody === 'json' ? JSON.parse(evalExpr(p.jsonBody, ctx)) : null;
        const rawBody = p.sendBody && p.contentType === 'raw' ? evalExpr(p.body, ctx) : null;
        const responseFormat = p.options?.response?.response?.responseFormat;
        try {
          results.push(services.request({ method, url, query, body, rawBody, responseFormat }));
        } catch (e) {
          if (node.onError === 'continueRegularOutput') results.push({ json: { error: { message: e.message } } });
          else throw e;
        }
      }
      return [results];
    }
    if (t === 'n8n-nodes-base.gmail') {
      if (p.resource !== 'draft' || p.operation !== 'create') throw new Error('sim: gmail node must be draft/create');
      const ctx = { $: (n) => wrap$(n), $json: input[0].json, $workflow: workflowCtx };
      try {
        const r = env.gmail.createDraft({ sendTo: evalExpr(p.options.sendTo, ctx), subject: evalExpr(p.subject, ctx), message: evalExpr(p.message, ctx), from: evalExpr(p.options.fromAlias, ctx) });
        return [[{ json: r }]];
      } catch (e) {
        if (node.onError === 'continueRegularOutput') return [[{ json: { error: { message: e.message } } }]];
        throw e;
      }
    }
    if (t === 'n8n-nodes-base.executeWorkflow') {
      chained.push(evalExpr(p.workflowId.value, { $: (n) => wrap$(n), $json: input[0].json, $workflow: workflowCtx }));
      return [input];
    }
    throw new Error(`sim: unsupported node type ${t}`);
  }

  const queue = [[trigger, opts.triggerItems || [{ json: {} }]]];
  while (queue.length) {
    const [name, input] = queue.shift();
    const node = byName.get(name);
    if (node.disabled) continue;
    const outs = await exec(node, input);
    outputs.set(name, outs.find((o) => o.length) || outs[0] || []);
    order.push(name);
    const conns = (workflow.connections[name] || { main: [] }).main;
    outs.forEach((items, i) => {
      if (!items.length) return;
      for (const c of conns[i] || []) queue.push([c.node, items]);
    });
  }
  return { order, outputs, chained, services, staticData };
}

module.exports = { run, makeServices, evalExpr };
