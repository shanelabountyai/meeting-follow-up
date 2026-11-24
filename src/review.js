'use strict';
// Needs-Review sidecar (PRD §1 step 8, §2 rule 4): "<transcript name>.review.json" next to the moved transcript,
// holding the reason, the raw model output and the candidates, plus the summary already extracted so a person
// only has to pick a company. It lives in the same Drive folder, with the same sharing, as the transcript.
const N = require('./normalize');

const HOW_TO_RESOLVE = 'To attach this meeting to a company: create "<transcript base name>.match.json" containing {"companyId": "<HubSpot company id>"} (optionally "dealId"), put it in Meetings/Inbox, and move the transcript back to Meetings/Inbox. The next run skips matching and uses that id.';

function sidecarName(transcriptName) {
  return `${N.baseKey(transcriptName)}.review.json`;
}

function buildSidecar({ fileName, fileId, reason, detail, rawOutput, candidates, ex, promptVersion, misses, flags, processedAt }) {
  return {
    n7: 'needs-review',
    file: { name: fileName, id: fileId },
    reason,
    detail: detail || '',
    processedAt,
    promptVersion,
    candidates: (candidates || []).map((c) => ({ companyId: c.id, name: c.name, domain: c.domain })),
    extracted: ex ? { title: ex.title, meetingDate: ex.meetingDate, summary: ex.summary, decisions: ex.decisions, actionItems: ex.actionItems } : null,
    checks: { misses: misses || [], flags: flags || [] },
    rawModelOutput: rawOutput == null ? null : String(rawOutput).slice(0, 20000),
    howToResolve: HOW_TO_RESOLVE,
  };
}

// Drive multipart upload body (POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart).
const BOUNDARY = 'n7-review-boundary';
function multipartUpload({ name, parentId, json }) {
  const meta = { name, parents: [parentId], mimeType: 'application/json' };
  return [`--${BOUNDARY}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(meta), `--${BOUNDARY}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(json, null, 2), `--${BOUNDARY}--`, ''].join('\r\n');
}

// Error-path row for the `errors` tab, and a 15-minute alert throttle so an outage cannot flood the webhook.
function shapeError(err, lastAlertMs, nowMs) {
  const send = !(lastAlertMs && nowMs - lastAlertMs < 15 * 60 * 1000);
  const node = err?.execution?.lastNodeExecuted ?? 'unknown';
  const message = String(err?.execution?.error?.message ?? 'unknown error').replace(/\s+/g, ' ').slice(0, 300);
  return {
    send,
    row: [new Date(nowMs).toISOString(), String(err?.execution?.id ?? ''), node, message],
    text: `N7 Meeting Follow-Up failed at "${node}" (execution ${err?.execution?.id ?? '?'}): ${message}`,
  };
}

module.exports = { sidecarName, buildSidecar, multipartUpload, BOUNDARY, shapeError, HOW_TO_RESOLVE };
