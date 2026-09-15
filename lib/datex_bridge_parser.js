'use strict';

function esc(name) { return String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function elementRe(name, flags = 'gi') {
  const n = esc(name);
  return new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${n}\\b([^>]*)>([\\s\\S]*?)<\\/(?:(?:[A-Za-z_][\\w.-]*):)?${n}\\s*>`, flags);
}
function findElements(xml, name) {
  const out = []; const re = elementRe(name); let m;
  while ((m = re.exec(String(xml || '')))) out.push({ attrs: m[1] || '', inner: m[2] || '', full: m[0] });
  return out;
}
function findText(xml, name) {
  const found = findElements(xml, name)[0];
  if (!found) return '';
  return decodeEntities(found.inner.replace(/<[^>]+>/g, '').trim());
}
function attr(attrs, name) {
  const re = new RegExp(`(?:^|\\s)(?:(?:[A-Za-z_][\\w.-]*):)?${esc(name)}\\s*=\\s*["']([^"']*)["']`, 'i');
  const m = re.exec(String(attrs || '')); return m ? decodeEntities(m[1]) : '';
}
function decodeEntities(value) {
  return String(value || '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
}
function toDate(value) { const d = value ? new Date(value) : null; return d && Number.isFinite(d.getTime()) ? d.toISOString() : ''; }
function extractIsrs(value) {
  const text = String(value || '').toUpperCase();
  const matches = text.match(/NL[A-Z0-9]{18}/g);
  return matches && matches.length ? matches[0] : '';
}
function numberText(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }

function recordState(operatorStatus, probability, ended, cancelled) {
  if (ended || cancelled || operatorStatus === 'beingTerminated') return 'closed';
  if (operatorStatus === 'approved') return 'planned';
  if (operatorStatus === 'beingImplemented' || operatorStatus === 'implemented') return 'open';
  return 'unknown';
}

function parseBridgeFeed(xml) {
  const source = String(xml || '');
  if (!source.trim()) throw new Error('Empty DATEX II document');
  const publicationTime = toDate(findText(source, 'publicationTime'));
  const situations = findElements(source, 'situation');
  const records = [];
  for (const situation of situations) {
    const situationId = attr(situation.attrs, 'id');
    const situationVersion = Number(attr(situation.attrs, 'version')) || 0;
    const situationVersionTime = toDate(findText(situation.full, 'situationVersionTime'));
    const situationEnded = findText(situation.full, 'end').toLowerCase() === 'true';
    const situationCancelled = findText(situation.full, 'cancel').toLowerCase() === 'true';
    const situationIsrs = extractIsrs(situationId) || extractIsrs(situation.full);
    for (const record of findElements(situation.inner, 'situationRecord')) {
      const type = findText(record.full, 'generalNetworkManagementType');
      if (type !== 'bridgeSwingInOperation') continue;
      const recordId = attr(record.attrs, 'id');
      const operatorStatus = findText(record.full, 'operatorActionStatus');
      const probability = findText(record.full, 'probabilityOfOccurrence');
      const ended = situationEnded || findText(record.full, 'end').toLowerCase() === 'true';
      const cancelled = situationCancelled || findText(record.full, 'cancel').toLowerCase() === 'true';
      const start = toDate(findText(record.full, 'overallStartTime'));
      const end = toDate(findText(record.full, 'overallEndTime'));
      const latitude = numberText(findText(record.full, 'latitude'));
      const longitude = numberText(findText(record.full, 'longitude'));
      const isrs = extractIsrs(recordId) || situationIsrs || extractIsrs(record.full);
      records.push({
        situationId, recordId, situationVersion,
        recordVersion: Number(attr(record.attrs, 'version')) || 0,
        situationVersionTime, publicationTime, isrs,
        operatorStatus, probability, ended, cancelled, start, end, latitude, longitude,
        state: recordState(operatorStatus, probability, ended, cancelled)
      });
    }
  }
  return { publicationTime, records };
}

module.exports = { parseBridgeFeed, findElements, findText, attr, extractIsrs, recordState };
