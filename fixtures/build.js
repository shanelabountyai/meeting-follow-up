'use strict';
// Regenerates fixtures/transcripts, fixtures/expected, fixtures/recorded and fixtures/hubspot-seed.json from
// fixtures/spec.js. Deterministic (seeded); test/fixtures.test.js fails if the committed files drift from it.
// Usage: node fixtures/build.js            (write)
//        node fixtures/build.js --check    (exit 1 if any file would change)
const fs = require('fs');
const path = require('path');
const { HOST, HUBSPOT, FIXTURES, VARIANTS } = require('./spec');
const steps = require('../src/steps');
const N = require('../src/normalize');
const X = require('../src/extract');
const { loadPrompts } = require('../src/prompts');
const cfg = require('./test-config.json');

const ROOT = __dirname;
const WORDS_PER_MINUTE = 150;

// Neutral filler: no commitments, decisions, names, companies, addresses, links, digits or brackets.
const FILLER = [
  'Let me pull up the notes from last time.', 'That lines up with what we saw on our side.', 'Can you say a bit more about how the team uses it day to day?',
  'Mostly for the weekly review, and sometimes when a customer asks.', 'Okay, that helps.', 'Sorry, you cut out for a second there.', 'Can you hear me now?',
  'Yes, much better.', 'So the way it works today is mostly by hand.', 'Right, and that is where the time goes.', 'Interesting. Is that the same for every region?',
  'More or less. One office does it a little differently.', 'Got it.', 'I think that is the part people complain about most.', 'Makes sense.',
  'We tried a different approach a while back and it did not stick.', 'Do you remember why it did not stick?', 'Partly training, partly that the old way felt faster.',
  'That is common.', 'Let me share my screen for a moment.', 'Can everyone see the sheet?', 'Yes, we can see it.',
  'So these columns are filled in by different people.', 'And this one is often empty.', 'Is that a problem for the monthly numbers?', 'Sometimes, yes.',
  'Okay, let me make a note of that.', 'Going back to the earlier point for a second.', 'Sure, go ahead.', 'How often does that happen in a normal month?',
  'A handful of times, maybe more in the busy season.', 'That is useful context.', 'I had not thought about it that way.', 'Same here, honestly.',
  'Let me stop sharing.', 'Where were we?', 'We were on the second topic.', 'Right, thanks.', 'Any questions on that part before we move on?',
  'Not from me.', 'Nothing from my side either.', 'Good, let us keep going.', 'This is mostly background, but it matters for the plan.',
  'The team is small, so everyone wears a few hats.', 'That explains a lot.', 'It does.', 'The reports go out on Monday mornings at the moment.',
  'And people read them?', 'Some do. Most skim the first page.', 'Fair enough.', 'We get the same feedback every quarter.', 'What kind of feedback?',
  'Mostly that the numbers arrive too late to act on.', 'That comes up a lot in conversations like this.', 'Is the data clean enough to start with?',
  'Mostly. There are some gaps in the older records.', 'Older meaning more than a year?', 'Roughly, yes.', 'Okay.', 'I see.', 'Hmm, good point.',
];

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const seedOf = (id) => [...id].reduce((s, c) => s * 31 + c.charCodeAt(0), 7);

function turnsFor(f) {
  const r = rng(seedOf(f.id));
  const target = f.minutes * WORDS_PER_MINUTE;
  const scriptWords = f.script.reduce((s, [, t]) => s + t.split(/\s+/).length, 0);
  const filler = [];
  let words = scriptWords;
  let speaker = 0;
  while (words < target) {
    const n = 1 + Math.floor(r() * 3);
    const text = Array.from({ length: n }, () => FILLER[Math.floor(r() * FILLER.length)]).join(' ');
    speaker = (speaker + 1 + Math.floor(r() * (f.people.length - 1))) % f.people.length;
    filler.push([f.people[speaker], text]);
    words += text.split(/\s+/).length;
  }
  // Spread the scripted lines evenly through the filler, in order; never two scripted lines at the same slot.
  const out = [];
  const gap = filler.length / (f.script.length + 1);
  let si = 0;
  filler.forEach((t, i) => {
    while (si < f.script.length && i >= Math.round(gap * (si + 1))) out.push(f.script[si++]);
    out.push(t);
  });
  while (si < f.script.length) out.push(f.script[si++]);
  // Merge adjacent turns by the same speaker so the transcript reads naturally.
  return out.reduce((acc, [s, t]) => {
    const last = acc[acc.length - 1];
    if (last && last[0] === s) last[1] += ' ' + t; else acc.push([s, t]);
    return acc;
  }, []);
}

const ts = (sec) => { const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`; };

function render(f, turns) {
  if (f.format === 'vtt') {
    const cues = [];
    let t = 0;
    for (const [s, text] of turns) {
      const words = text.split(' ');
      for (let i = 0; i < words.length; i += 12) {
        const part = words.slice(i, i + 12).join(' ');
        const dur = Math.max(1.2, part.split(' ').length / 2.5);
        cues.push(`${cues.length + 1}\n${ts(t)} --> ${ts(t + dur)}\n<v ${s}>${part}</v>`);
        t += dur + 0.2;
      }
    }
    return `WEBVTT\n\nNOTE\n${f.header.join('\n')}\n\n${cues.join('\n\n')}\n`;
  }
  return `${f.header.join('\n')}\n\n${turns.map(([s, t]) => `${s}: ${t}`).join('\n')}\n`;
}

const recordedResponse = (id, input, requestChars) => ({
  id: `msg_recorded_${id}`,
  type: 'message',
  role: 'assistant',
  model: 'recorded-stand-in',
  content: [{ type: 'tool_use', id: `toolu_recorded_${id}`, name: X.TOOL_NAME, input }],
  stop_reason: 'tool_use',
  // Not measured: chars/4 estimates so cost and token logging have numbers to carry. See fixtures/README.md.
  usage: { input_tokens: Math.ceil(requestChars / 4), output_tokens: Math.ceil(JSON.stringify(input).length / 4) },
});

function build() {
  const prompts = loadPrompts(path.join(ROOT, '..'));
  const files = {};
  const put = (rel, content) => { files[rel] = typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n'; };
  const index = [];
  for (const f of FIXTURES) {
    const content = render(f, turnsFor(f));
    put(`transcripts/${f.file}`, content);
    const text = steps.toText(`.${f.format}`, Buffer.from(content, 'utf8'));
    const chunks = N.chunkBySpeakerTurn(text, cfg.chunkChars);
    const reqChars = (c) => prompts.extract.length + c.length;
    let recorded;
    if (chunks.length === 1) {
      recorded = { responses: [recordedResponse(f.id, f.recorded, reqChars(text))], reduce: null };
    } else {
      // Map stand-ins: each chunk reports the expected items whose quotes it contains, quoted exactly.
      const responses = chunks.map((c, i) => {
        const fc = N.foldForMatch(c);
        // (owners are unique within F06, so the owner finds the recorded item; the map quote is the exact one)
        const items = f.expected.actionItems.filter((e) => fc.includes(N.foldForMatch(e.quote)))
          .map((e) => ({ ...f.recorded.actionItems.find((a) => a.owner === e.owner), quote: e.quote }));
        return recordedResponse(`${f.id}_part${i + 1}`, { ...f.recorded, summary: `Part ${i + 1} of the workshop. ${f.recorded.summary}`, actionItems: items }, reqChars(c));
      });
      recorded = { responses, reduce: recordedResponse(`${f.id}_reduce`, f.recorded, prompts.reduce.length + 4000 * chunks.length) };
    }
    put(`recorded/${f.id}.json`, recorded);
    put(`expected/${f.id}.expected.json`, {
      id: f.id, file: f.file, format: f.format, minutes: f.minutes, covers: f.covers,
      chars: text.length, chunks: chunks.length, ...f.expected,
    });
    index.push({ id: f.id, file: f.file, minutes: f.minutes, chars: text.length, chunks: chunks.length, covers: f.covers });
  }
  for (const v of VARIANTS) {
    const base = FIXTURES.find((f) => f.id === v.base);
    put(`recorded/variants/${v.id}.json`, { base: v.base, expect: v.expect, responses: [recordedResponse(v.id, v.mutate(JSON.parse(JSON.stringify(base.recorded))), 0)], reduce: null });
  }
  put('hubspot-seed.json', { note: 'Synthetic demo records for the fixtures. Ids are those of the offline fake; HubSpot assigns its own on import.', host: HOST, ...HUBSPOT });
  put('index.json', index);
  return files;
}

if (require.main === module) {
  const files = build();
  const check = process.argv.includes('--check');
  let drift = 0;
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(ROOT, rel);
    const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    if (cur === content) continue;
    drift++;
    if (check) console.error(`drift: fixtures/${rel}`);
    else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
  }
  if (check && drift) process.exit(1);
  console.log(check ? 'fixtures: up to date' : `fixtures: wrote ${drift} file(s)`);
}

module.exports = { build };
