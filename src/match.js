'use strict';
// Matching a meeting to HubSpot (PRD §2, D-04): deterministic first, model second, person last.
// planSearches() builds the HubSpot CRM search bodies the workflow's HTTP nodes send; decideMatch() applies the
// rules to the results. A match is never made on a fuzzy or model-inferred name: searches use EQ, and rules 2
// and 3 only see strings that postChecks() verified are in the transcript.

const MAX_GROUPS = 5; // HubSpot CRM search allows at most 5 filterGroups (OR-ed)
const NONE = 'n7-no-value.invalid'; // an EQ value no record has, so an empty list searches for nothing

const domainOf = (email) => String(email || '').toLowerCase().split('@')[1] || '';

function eqSearch(property, values, properties) {
  const vals = values.length ? values.slice(0, MAX_GROUPS) : [NONE];
  return {
    filterGroups: vals.map((v) => ({ filters: [{ propertyName: property, operator: 'EQ', value: v }] })),
    properties,
    limit: 20,
  };
}

// headerEmails: from the transcript header / Attendees line (normalize.headerEmails), never from the model.
function planSearches({ headerEmails, ownDomains, ex, attendeeEmails }) {
  const own = (ownDomains || []).map((d) => d.toLowerCase());
  const domains = [...new Set((headerEmails || []).map(domainOf).filter((d) => d && !own.includes(d)))];
  const mentions = [...new Set((ex.companyMentions || []).map((m) => m.trim()).filter(Boolean))];
  const contactEmails = [...new Set((attendeeEmails || []).filter((e) => e && !own.includes(domainOf(e))))];
  const skipped = [];
  if (domains.length > MAX_GROUPS) skipped.push(`domains beyond ${MAX_GROUPS}: ${domains.slice(MAX_GROUPS).join(', ')}`);
  if (mentions.length > MAX_GROUPS) skipped.push(`mentions beyond ${MAX_GROUPS}: ${mentions.slice(MAX_GROUPS).join(', ')}`);
  return {
    domains: domains.slice(0, MAX_GROUPS),
    mentions: mentions.slice(0, MAX_GROUPS),
    dealName: ex.dealReference || null,
    skipped,
    domainSearch: eqSearch('domain', domains, ['name', 'domain']),
    dealSearch: eqSearch('dealname', ex.dealReference ? [ex.dealReference] : [], ['dealname']),
    nameSearch: eqSearch('name', mentions, ['name', 'domain']),
    contactSearch: eqSearch('email', contactEmails, ['email']),
  };
}

const hits = (res) => (Array.isArray(res?.results) ? res.results : []);
const company = (r) => ({ id: String(r.id), name: r.properties?.name ?? null, domain: r.properties?.domain ?? null });
const distinct = (list) => [...new Map(list.map((c) => [c.id, c])).values()];

// override: parsed .match.json ({companyId, dealId?}) or null.
// dealCompanyIds: company ids associated to the single deal hit (empty when there was not exactly one).
function decideMatch({ override, domainRes, dealRes, dealCompanyIds, nameRes }) {
  const deals = hits(dealRes);
  const oneDeal = deals.length === 1 ? String(deals[0].id) : null;
  const dealCos = [...new Set((dealCompanyIds || []).map(String))];
  const dealFor = (companyId) => (oneDeal && dealCos.includes(companyId) ? oneDeal : null);

  if (override && override.companyId) {
    return { matched: true, rule: 'override', companyId: String(override.companyId), dealId: override.dealId ? String(override.dealId) : null, candidates: [] };
  }
  const byDomain = distinct(hits(domainRes).map(company));
  if (byDomain.length === 1) return { matched: true, rule: 'domain', companyId: byDomain[0].id, dealId: dealFor(byDomain[0].id), candidates: [] };

  if (oneDeal && dealCos.length === 1) return { matched: true, rule: 'deal', companyId: dealCos[0], dealId: oneDeal, candidates: [] };

  const byName = distinct(hits(nameRes).map(company));
  if (byName.length === 1) return { matched: true, rule: 'name', companyId: byName[0].id, dealId: dealFor(byName[0].id), candidates: [] };

  const candidates = distinct([...byName, ...byDomain]).slice(0, 3);
  return { matched: false, rule: 'none', companyId: null, dealId: null, candidates };
}

// Attendees whose email has no HubSpot contact are listed in the note as "not in CRM" (PRD §6 item 3).
function notInCrm(attendees, contactRes, ownDomains) {
  const own = (ownDomains || []).map((d) => d.toLowerCase());
  const known = new Set(hits(contactRes).map((r) => String(r.properties?.email || '').toLowerCase()));
  return attendees.filter((a) => a.email && !own.includes(domainOf(a.email)) && !known.has(a.email.toLowerCase())).map((a) => a.name);
}

function parseOverride(json) {
  const o = typeof json === 'string' ? JSON.parse(json) : json;
  if (!o || typeof o !== 'object') throw new Error('.match.json: not an object');
  const id = String(o.companyId ?? '').trim();
  if (!/^\d+$/.test(id)) throw new Error('.match.json: companyId must be a HubSpot company id (digits)');
  const deal = o.dealId == null || o.dealId === '' ? null : String(o.dealId).trim();
  if (deal !== null && !/^\d+$/.test(deal)) throw new Error('.match.json: dealId must be digits or absent');
  return { companyId: id, dealId: deal };
}

module.exports = { planSearches, decideMatch, notInCrm, parseOverride, eqSearch, MAX_GROUPS, NONE };
