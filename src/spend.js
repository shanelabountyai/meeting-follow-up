'use strict';
// Spend rails (PRD §4): a per-day cap on model calls and a per-file token ceiling, checked before any call.
// Cost per run is computed from the response usage. Prices are config values the owner fills in; while they
// are null the ledger records tokens and leaves cost_usd empty rather than guessing a price.

const estimateTokens = (chars) => Math.ceil(Number(chars || 0) / 4);
const callsNeeded = (chunks) => (chunks > 1 ? chunks + 1 : 1);

// → { allowed, reason } where reason is 'daily_cap' | 'token_ceiling' | ''
function gate({ callsToday, chunks, textChars, cfg }) {
  const need = callsNeeded(chunks);
  if (callsToday + need > cfg.dailyCallCap) return { allowed: false, reason: 'daily_cap', need };
  if (estimateTokens(textChars) > cfg.perFileTokenCeiling) return { allowed: false, reason: 'token_ceiling', need };
  return { allowed: true, reason: '', need };
}

function costUsd(usage, cfg) {
  const pin = cfg.priceInputPerMTokUsd;
  const pout = cfg.priceOutputPerMTokUsd;
  if (typeof pin !== 'number' || typeof pout !== 'number') return null;
  return Math.round(((usage.input_tokens * pin + usage.output_tokens * pout) / 1e6) * 1e6) / 1e6;
}

module.exports = { estimateTokens, callsNeeded, gate, costUsd };
