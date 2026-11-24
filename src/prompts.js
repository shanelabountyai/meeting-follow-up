'use strict';
// Loads prompts/ for the build script and the tests (Node only; the workflow gets these inlined at build time).
const fs = require('fs');
const path = require('path');

function systemOf(md) {
  const m = /<!-- SYSTEM PROMPT START -->\n([\s\S]*?)\n<!-- SYSTEM PROMPT END -->/.exec(md);
  if (!m) throw new Error('prompt file has no SYSTEM PROMPT START/END markers');
  return m[1].trim();
}
const versionOf = (md) => {
  const m = /^version:\s*(\S+)$/m.exec(md);
  if (!m) throw new Error('prompt file has no version');
  return m[1];
};

function loadPrompts(root = path.join(__dirname, '..')) {
  const p = (...a) => path.join(root, 'prompts', ...a);
  const extractMd = fs.readFileSync(p('extract.md'), 'utf8');
  const reduceMd = fs.readFileSync(p('reduce.md'), 'utf8');
  const exDir = p('examples');
  const examples = fs.readdirSync(exDir).filter((f) => f.endsWith('.transcript.txt')).sort().map((f) => {
    const stem = f.replace(/\.transcript\.txt$/, '');
    const transcript = fs.readFileSync(path.join(exDir, f), 'utf8').trim();
    const output = JSON.parse(fs.readFileSync(path.join(exDir, `${stem}.output.json`), 'utf8'));
    return `<example>\n<transcript>\n${transcript}\n</transcript>\n<record_meeting_input>\n${JSON.stringify(output, null, 2)}\n</record_meeting_input>\n</example>`;
  });
  const extract = systemOf(extractMd) + (examples.length ? `\n\nWorked example (synthetic; shows the expected output for a short meeting, including an instruction in the transcript that is not followed):\n\n${examples.join('\n\n')}` : '');
  return {
    version: versionOf(extractMd),
    reduceVersion: versionOf(reduceMd),
    extract,
    reduce: systemOf(reduceMd),
    schema: JSON.parse(fs.readFileSync(p('extract.schema.json'), 'utf8')),
  };
}

module.exports = { loadPrompts, systemOf, versionOf };
