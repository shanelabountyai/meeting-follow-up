'use strict';
// Transcript intake: file classification, .vtt flattening, plain-text normalisation, header parsing and
// chunking by speaker turn (PRD §1 step 2). Pure functions; inlined into the workflow's Code nodes.

const TRANSCRIPT_EXT = ['.txt', '.md', '.docx', '.vtt'];
const HEADER_KEYS = ['attendees', 'participants', 'invitees', 'title', 'meeting', 'subject', 'date', 'organizer', 'note', 'webvtt', 'kind', 'language'];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SPEAKER_RE = /^([A-Z][\w.'-]*(?: [A-Z][\w.'-]*){0,3}):\s+\S/;

function extOf(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.match.json')) return '.match.json';
  if (n.endsWith('.review.json')) return '.review.json';
  const m = /\.[^./]+$/.exec(n);
  return m ? m[0] : '';
}

// 'transcript' | 'override' | 'sidecar' | 'ignore'
function classify(name) {
  const e = extOf(name);
  if (e === '.match.json') return 'override';
  if (e === '.review.json') return 'sidecar';
  return TRANSCRIPT_EXT.includes(e) ? 'transcript' : 'ignore';
}

// "acme-call.vtt" and "acme-call.match.json" share the key "acme-call".
function baseKey(name) {
  const n = String(name || '');
  const e = extOf(n);
  return e ? n.slice(0, n.length - e.length) : n;
}

function normalizeText(s) {
  return String(s ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');

// WebVTT → "Name: text" lines. Timestamps and cue ids are dropped; <v Name> voice tags (Google Meet, Teams)
// and "Name: text" cue bodies (Zoom) both become Name: prefixes; consecutive cues by one speaker are joined.
// NOTE blocks are kept as header lines (exports put the title and attendee list there).
function vttToText(vtt) {
  const blocks = normalizeText(vtt).split(/\n\s*\n/);
  const header = [];
  const turns = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    if (/^WEBVTT/.test(lines[0])) { header.push(...lines.slice(1).filter((l) => /\S/.test(l) && !/^(Kind|Language):/i.test(l))); continue; }
    if (/^NOTE\b/.test(lines[0])) { header.push(...[lines[0].replace(/^NOTE\s*/, ''), ...lines.slice(1)].filter((l) => /\S/.test(l))); continue; }
    if (/^(STYLE|REGION)\b/.test(lines[0])) continue;
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const body = lines.slice(ti + 1).join(' ').trim();
    if (!body) continue;
    let speaker = null;
    let text = body;
    const v = /^<v(?:\.[^ >]*)?\s+([^>]+)>([\s\S]*)$/.exec(body);
    if (v) { speaker = v[1].trim(); text = v[2]; } else {
      const z = /^([^:<>]{1,60}):\s+([\s\S]*)$/.exec(body);
      if (z) { speaker = z[1].trim(); text = z[2]; }
    }
    text = decodeEntities(text.replace(/<\/?[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && speaker && last.speaker === speaker) last.text += ' ' + text;
    else turns.push({ speaker, text });
  }
  const body = turns.map((t) => (t.speaker ? `${t.speaker}: ${t.text}` : t.text)).join('\n');
  return normalizeText([...header, '', body].join('\n'));
}

function isHeaderKeyLine(line) {
  const m = /^([A-Za-z]+)\s*:/.exec(line);
  return !!m && HEADER_KEYS.includes(m[1].toLowerCase());
}

function isSpeakerTurn(line) {
  return SPEAKER_RE.test(line) && !isHeaderKeyLine(line);
}

// Lines before the first speaker turn.
function headerLines(text) {
  const lines = String(text).split('\n');
  const i = lines.findIndex(isSpeakerTurn);
  return i < 0 ? lines.slice(0, 40) : lines.slice(0, i);
}

const emailsIn = (s) => [...new Set((String(s).match(EMAIL_RE) || []).map((e) => e.toLowerCase().replace(/\.+$/, '')))];

// Rule 1 source (PRD §2): emails in the header, plus any Attendees:/Participants:/Invitees: line anywhere.
function headerEmails(text) {
  const lines = String(text).split('\n');
  const attendeeLines = lines.filter((l) => /^(attendees|participants|invitees)\s*:/i.test(l.trim()));
  return emailsIn([...headerLines(text), ...attendeeLines].join('\n'));
}

const transcriptEmails = (text) => emailsIn(text);

function headerField(text, key) {
  const re = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'i');
  for (const l of headerLines(text)) { const m = re.exec(l.trim()); if (m) return m[1].trim(); }
  return null;
}

// Split into chunks of at most maxChars on speaker-turn boundaries. The header is repeated at the top of
// every chunk so each map call sees the attendee list. A single turn longer than the budget is hard-split.
function chunkBySpeakerTurn(text, maxChars) {
  const t = String(text);
  if (t.length <= maxChars) return [t];
  const lines = t.split('\n');
  const start = lines.findIndex(isSpeakerTurn);
  const header = start > 0 ? lines.slice(0, start).join('\n') + '\n\n' : '';
  const turns = [];
  for (const l of lines.slice(Math.max(start, 0))) {
    if (isSpeakerTurn(l) || !turns.length) turns.push(l); else turns[turns.length - 1] += '\n' + l;
  }
  const budget = Math.max(1000, maxChars - header.length);
  const chunks = [];
  let cur = '';
  for (let turn of turns) {
    while (turn.length > budget) {
      if (cur) { chunks.push(cur); cur = ''; }
      chunks.push(turn.slice(0, budget));
      turn = turn.slice(budget);
    }
    if (cur && cur.length + 1 + turn.length > budget) { chunks.push(cur); cur = ''; }
    cur = cur ? cur + '\n' + turn : turn;
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => header + c);
}

// For "does this quote occur in the transcript" (PRD §3): case-insensitive, whitespace-normalised,
// typographic quotes and dashes folded, and the speaker prefix of a .vtt line does not matter.
function foldForMatch(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  TRANSCRIPT_EXT, EMAIL_RE, extOf, classify, baseKey, normalizeText, vttToText, headerLines, headerEmails,
  transcriptEmails, headerField, chunkBySpeakerTurn, foldForMatch, isSpeakerTurn, emailsIn,
};
