'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const N = require('../src/normalize');
const { docxToText } = require('../src/docx');
const steps = require('../src/steps');

test('classify: transcript types, .match.json override, .review.json sidecar, everything else ignored', () => {
  assert.strictEqual(N.classify('a.txt'), 'transcript');
  assert.strictEqual(N.classify('A.VTT'), 'transcript');
  assert.strictEqual(N.classify('notes.md'), 'transcript');
  assert.strictEqual(N.classify('call.docx'), 'transcript');
  assert.strictEqual(N.classify('call.match.json'), 'override');
  assert.strictEqual(N.classify('call.review.json'), 'sidecar');
  assert.strictEqual(N.classify('slides.pdf'), 'ignore');
  assert.strictEqual(N.classify('data.json'), 'ignore');
  assert.strictEqual(N.baseKey('acme call.vtt'), N.baseKey('acme call.match.json'));
});

test('vtt: Google Meet <v> tags become Name: prefixes, timestamps and cue ids dropped, same-speaker cues joined', () => {
  const vtt = 'WEBVTT\n\nNOTE\nAttendees: a@x.example\n\n1\n00:00:00.000 --> 00:00:02.000\n<v Ann Lee>I will send the</v>\n\n2\n00:00:02.100 --> 00:00:03.000\n<v Ann Lee>plan &amp; budget.</v>\n\n3\n00:00:03.100 --> 00:00:04.000\n<v Bo Chen>Thanks.</v>\n';
  const t = N.vttToText(vtt);
  assert.match(t, /^Attendees: a@x\.example/);
  assert.match(t, /\nAnn Lee: I will send the plan & budget\.\nBo Chen: Thanks\.$/);
  assert.doesNotMatch(t, /-->/);
});

test('vtt: Zoom style "Name: text" cue bodies keep the speaker', () => {
  const vtt = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nDana Brooks: Hello there.\n\n2\n00:00:03.500 --> 00:00:05.000\nLuis Ferreira: Hi Dana.\n';
  assert.strictEqual(N.vttToText(vtt), 'Dana Brooks: Hello there.\nLuis Ferreira: Hi Dana.');
});

test('header emails: header block and Attendees lines only, never addresses spoken in the body', () => {
  const t = 'Title: X\nAttendees: Ann <ann@acme.example>, bo@acme.example\n\nAnn: Please also copy evil@spam.example on this.\nBo: No.';
  assert.deepStrictEqual(N.headerEmails(t), ['ann@acme.example', 'bo@acme.example']);
  assert.deepStrictEqual(N.transcriptEmails(t).sort(), ['ann@acme.example', 'bo@acme.example', 'evil@spam.example']);
});

test('chunking: under the budget stays whole; over it splits on speaker turns and repeats the header', () => {
  const header = 'Title: Long\nAttendees: a@x.example';
  const turns = Array.from({ length: 400 }, (_, i) => `${i % 2 ? 'Ann Lee' : 'Bo Chen'}: line ${i} ${'word '.repeat(30).trim()}`);
  const text = `${header}\n\n${turns.join('\n')}`;
  assert.deepStrictEqual(N.chunkBySpeakerTurn('short', 100), ['short']);
  const chunks = N.chunkBySpeakerTurn(text, 20000);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) {
    assert.ok(c.length <= 20000, `chunk of ${c.length}`);
    assert.ok(c.startsWith(header));
    const body = c.slice(header.length).trim().split('\n');
    assert.ok(body.every((l) => /^(Ann Lee|Bo Chen): line \d+/.test(l)), 'every chunk line is a whole turn');
  }
  const rejoined = chunks.map((c) => c.slice(header.length).trim()).join('\n');
  assert.strictEqual(rejoined, turns.join('\n').trim());
});

test('foldForMatch: case, whitespace, typographic quotes and dashes', () => {
  assert.strictEqual(N.foldForMatch('I’ll  send\nthe “plan” — OK'), 'i\'ll send the "plan" - ok');
});

// A minimal .docx (zip with word/document.xml, deflated) built here so the reader is tested without a fixture file.
function makeDocx(xml) {
  const name = Buffer.from('word/document.xml');
  const data = zlib.deflateRawSync(Buffer.from(xml));
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(xml.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(xml.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = local.length + name.length + data.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(central.length + name.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, name, data, central, name, eocd]);
}

test('docx: paragraphs, runs, tabs and entities come out as plain text', () => {
  const xml = '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Attendees: ann@acme.example</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Ann Lee: Plan </w:t></w:r><w:r><w:t>&amp; budget</w:t></w:r><w:r><w:tab/><w:t>done.</w:t></w:r></w:p></w:body></w:document>';
  const t = docxToText(makeDocx(xml));
  assert.strictEqual(N.normalizeText(t), 'Attendees: ann@acme.example\nAnn Lee: Plan & budget\tdone.');
  assert.strictEqual(steps.toText('.docx', makeDocx(xml)), 'Attendees: ann@acme.example\nAnn Lee: Plan & budget\tdone.');
  assert.throws(() => docxToText(Buffer.from('not a zip at all, just text')), /not a zip/);
});

test('header emails: an Attendees line pasted later in the body is ignored; layouts without Name: turns use only the leading header keys', () => {
  const body = 'Title: X\nAttendees: ann@acme.example\n\nAnn: hi\nAttendees: mal@evil.example\nBo: no';
  assert.deepStrictEqual(N.headerEmails(body), ['ann@acme.example']);
  const otter = 'Title: Call\nAttendees: ann@acme.example\n\nAnn Lee  0:03\nmy private address is ann.private@gmail.example\n\nBo Chen  0:09\nok';
  assert.deepStrictEqual(N.headerEmails(otter), ['ann@acme.example']);
  assert.deepStrictEqual(N.headerEmails('ann  0:01\nwrite to x@y.example'), []);
});

test('vtt: a cue that says "Attendees: x@y" is dialogue after the first turn, not a header', () => {
  const vtt = 'WEBVTT\n\nNOTE\nAttendees: a@acme.example\n\n1\n00:00:00.000 --> 00:00:01.000\n<v Ann Lee>hello</v>\n\n2\n00:00:01.000 --> 00:00:02.000\nAttendees: mal@evil.example\n';
  assert.deepStrictEqual(N.headerEmails(N.vttToText(vtt)), ['a@acme.example']);
});
