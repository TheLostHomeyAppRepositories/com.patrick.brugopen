'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { version: APP_VERSION } = require('../package.json');

function requestBuffer(urlString, options = {}) {
  const { headers = {}, timeoutMs = 12000, maxBytes = 12 * 1024 * 1024, acceptStatuses = [200] } = options;
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlString); } catch (err) { return reject(err); }
    const transport = url.protocol === 'http:' ? http : https;
    let settled = false;
    let deadline = null;
    let req = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      fn(value);
    };
    req = transport.get(url, { headers: { 'User-Agent': `Homey-Brug-Open/${APP_VERSION}`, ...headers } }, (res) => {
      const statusCode = Number(res.statusCode || 0);
      if (!acceptStatuses.includes(statusCode)) {
        res.resume();
        return finish(reject, new Error(`HTTP ${statusCode} for ${url.hostname}`));
      }
      if (statusCode === 304) {
        res.resume();
        return finish(resolve, { statusCode, headers: res.headers, buffer: Buffer.alloc(0) });
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error(`Response exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(resolve, { statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
      res.on('error', err => finish(reject, err));
    });
    // Socket inactivity timeout plus an absolute deadline. The latter also covers cases
    // where DNS/TCP/TLS never progresses far enough for the socket timeout to help.
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out after ${timeoutMs} ms`)));
    deadline = setTimeout(() => req.destroy(new Error(`Request deadline exceeded after ${timeoutMs} ms`)), timeoutMs + 1000);
    req.on('error', err => finish(reject, err));
  });
}

function maybeGunzip(buffer, headers = {}, url = '') {
  const encoding = String(headers['content-encoding'] || '').toLowerCase();
  const contentType = String(headers['content-type'] || '').toLowerCase();
  const magicGzip = buffer && buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  if (magicGzip || encoding.includes('gzip') || contentType.includes('gzip') || String(url).endsWith('.gz')) {
    try { return zlib.gunzipSync(buffer); } catch (err) {
      if (magicGzip) throw err;
    }
  }
  return buffer;
}

async function getText(url, options = {}) {
  const response = await requestBuffer(url, options);
  if (response.statusCode === 304) return { ...response, text: '' };
  const unpacked = maybeGunzip(response.buffer, response.headers, url);
  return { ...response, text: unpacked.toString('utf8') };
}

async function getJson(url, options = {}) {
  const response = await getText(url, options);
  if (response.statusCode === 304) return { ...response, json: null };
  let value;
  try { value = JSON.parse(response.text); } catch (err) { throw new Error(`Invalid JSON response: ${err.message}`); }
  return { ...response, json: value };
}

module.exports = { requestBuffer, getText, getJson, maybeGunzip };
