'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Ajv2020 = require('ajv/dist/2020');
const S = require('../src/schema');
const { FIXTURES } = require('../fixtures/spec');
const schema = require('../prompts/extract.schema.json');
const example = require('../prompts/examples/example-1.output.json');

const ajv = new Ajv2020({ allErrors: true, strict: false });
const ajvValidate = ajv.compile(schema);
const good = () => JSON.parse(JSON.stringify(FIXTURES[0].recorded));

test('every recorded fixture output and the prompt example pass both validators', () => {
  for (const o of [...FIXTURES.map((f) => f.recorded), example]) {
    assert.deepStrictEqual(S.validateExtraction(o), { ok: true, errors: [] });
    assert.ok(ajvValidate(o), JSON.stringify(ajvValidate.errors));
  }
});

const BAD = {
  'extra key': (o) => { o.sentiment = 'positive'; },
  'missing key': (o) => { delete o.openQuestions; },
  'title over 80': (o) => { o.title = 'x'.repeat(81); },
  'date format': (o) => { o.meetingDate = '06/10/2026'; },
  'attendee extra key': (o) => { o.attendees[0].role = 'host'; },
  'external not boolean': (o) => { o.attendees[0].external = 'yes'; },
  'action item without quote': (o) => { delete o.actionItems[0].quote; },
  'empty quote': (o) => { o.actionItems[0].quote = ''; },
  'due not a date': (o) => { o.actionItems[0].due = 'Friday'; },
  'decisions not strings': (o) => { o.decisions = [1]; },
  'dealReference wrong type': (o) => { o.dealReference = 42; },
  'followUp extra key': (o) => { o.followUp.cc = 'x@y.example'; },
  'confidence above 1': (o) => { o.confidence.summary = 1.5; },
  'confidence as string': (o) => { o.confidence.actionItems = '0.8'; },
  'root not object': () => [],
};

test('schema failures: each mutation is rejected by the hand validator AND by Ajv against the JSON Schema', () => {
  for (const [name, mutate] of Object.entries(BAD)) {
    const o = good();
    const replaced = mutate(o);
    const target = replaced !== undefined ? replaced : o;
    assert.strictEqual(S.validateExtraction(target).ok, false, `hand validator accepted: ${name}`);
    assert.strictEqual(ajvValidate(target), false, `Ajv accepted: ${name}`);
  }
});

test('limits the JSON Schema only describes: followUp body over 180 words, impossible calendar dates', () => {
  const o = good();
  o.followUp.body = Array.from({ length: 181 }, () => 'word').join(' ');
  assert.match(S.validateExtraction(o).errors.join(), /more than 180 words/);
  const d = good();
  d.meetingDate = '2026-02-30';
  assert.strictEqual(S.validateExtraction(d).ok, false);
  const ok = good();
  ok.followUp.body = Array.from({ length: 180 }, () => 'word').join(' ');
  assert.ok(S.validateExtraction(ok).ok);
});

test('the hand validator requires exactly the schema\'s top-level keys', () => {
  assert.deepStrictEqual([...S.KEYS].sort(), [...schema.required].sort());
  assert.deepStrictEqual([...S.KEYS].sort(), Object.keys(schema.properties).sort());
});
