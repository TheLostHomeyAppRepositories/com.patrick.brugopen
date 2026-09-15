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
    const req = transport.get(url, { headers: { 'User-Agent': `Homey-Brug-Open/${APP_VERSION}`, ...headers } }, (res) => {
      const statusCode = Number(res.statusCode || 0);
      if (!acceptStatuses.includes(statusCode)) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode} for ${url.hostname}`));
      }
      if (statusCode === 304) {
        res.resume();
        return resolve({ statusCode, headers: res.headers, buffer: Buffer.alloc(0) });
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
      res.on('end', () => resolve({ statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
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
