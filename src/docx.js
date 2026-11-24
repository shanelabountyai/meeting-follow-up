'use strict';
// .docx → plain text without dependencies. n8n's Extract From File node has no .docx operation, so the
// workflow reads word/document.xml out of the zip itself. Needs the zlib builtin in Code nodes
// (NODE_FUNCTION_ALLOW_BUILTIN=crypto,zlib; see docs/SETUP.md).

// A transcript's document.xml is far below this; a zip bomb stops here instead of exhausting memory.
const MAX_XML_BYTES = 20 * 1024 * 1024;

function findEntry(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('docx: not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('docx: bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    if (name === wanted) return { method, csize, local };
    p += 46 + nlen + elen + clen;
  }
  return null;
}

function readZipEntry(buf, wanted, zlib) {
  const e = findEntry(buf, wanted);
  if (!e) throw new Error(`docx: ${wanted} not found`);
  const nlen = buf.readUInt16LE(e.local + 26);
  const elen = buf.readUInt16LE(e.local + 28);
  const start = e.local + 30 + nlen + elen;
  const data = buf.slice(start, start + e.csize);
  if (e.method === 0) return data;
  if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES });
  throw new Error(`docx: unsupported compression method ${e.method}`);
}

function documentXmlToText(xml) {
  return String(xml)
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function docxToText(buf, zlib) {
  const z = zlib || require('zlib');
  return documentXmlToText(readZipEntry(Buffer.from(buf), 'word/document.xml', z).toString('utf8'));
}

module.exports = { docxToText, documentXmlToText, readZipEntry };
