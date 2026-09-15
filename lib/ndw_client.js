'use strict';

const { getText } = require('./http');

const PLANNING_FEED_URL = 'https://opendata.ndw.nu/planningsfeed_brugopeningen.xml.gz';
const CURRENT_FEED_URL = 'https://opendata.ndw.nu/tijdelijke_verkeersmaatregelen_afsluitingen.xml.gz';

class NdwClient {
  constructor(options = {}) {
    this._getText = options.getText || getText;
    this.feedUrl = options.feedUrl || PLANNING_FEED_URL;
    this.timeoutMs = Number(options.timeoutMs || 15000);
    this.maxBytes = Number(options.maxBytes || 15 * 1024 * 1024);
    this._etag = '';
    this._lastModified = '';
  }

  async fetch() {
    const headers = { 'Accept-Encoding': 'gzip' };
    if (this._etag) headers['If-None-Match'] = this._etag;
    if (this._lastModified) headers['If-Modified-Since'] = this._lastModified;

    const response = await this._getText(this.feedUrl, {
      headers,
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxBytes,
      acceptStatuses: [200, 304],
    });

    if (response.headers.etag) this._etag = response.headers.etag;
    if (response.headers['last-modified']) this._lastModified = response.headers['last-modified'];

    return {
      changed: response.statusCode !== 304,
      xml: response.text,
      statusCode: response.statusCode,
      etag: this._etag,
      lastModified: this._lastModified,
    };
  }
}

module.exports = { NdwClient, PLANNING_FEED_URL, CURRENT_FEED_URL };
