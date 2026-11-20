import { sleep } from './util.js';

const API_BASE = 'https://discord.com/api/v10';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

class Semaphore {
  constructor(size) {
    this.size = size;
    this.available = size;
    this.waiters = [];
  }
  acquire() {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.available++;
  }
}

export class HttpError extends Error {
  constructor(status, body, method, pathname) {
    const detail =
      body && typeof body === 'object' ? body.message || JSON.stringify(body) : String(body ?? '');
    super(`HTTP ${status} ${method} ${pathname}${detail ? ` — ${detail}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export class RateLimitError extends HttpError {
  constructor(method, pathname, retryAfter, scope) {
    super(429, { message: 'rate limited' }, method, pathname);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
    this.scope = scope;
  }
}

export class Rest {
  constructor(
    token,
    { maxConcurrent = 4, maxWaitMs = 120000, onRateLimit = () => {}, onRequest = () => {} } = {},
  ) {
    this.token = token;
    this.sem = new Semaphore(Math.max(1, maxConcurrent));
    this.maxWaitMs = maxWaitMs;
    this.onRateLimit = onRateLimit;
    this.onRequest = onRequest;
    this.globalResetAt = 0;
    this.routeToBucket = new Map();
    this.buckets = new Map();
    this.stats = { requests: 0, retries: 0, hits429: 0, waitMs: 0 };
  }

  bucket(key) {
    let b = this.buckets.get(key);
    if (!b) {
      b = { remaining: Infinity, resetAt: 0, limit: Infinity, chain: Promise.resolve() };
      this.buckets.set(key, b);
    }
    return b;
  }

  routeKey(method, pathname) {
    return `${method} ${pathname.split('?')[0]}`;
  }

  /**
   * Per-bucket serialization + per-bucket quota + global 429 pause + concurrency cap.
   * Returns a release() that MUST be called.
   */
  async acquire(routeKey) {
    const bucketKey = this.routeToBucket.get(routeKey) ?? routeKey;
    const b = this.bucket(bucketKey);

    let unlock;
    const previous = b.chain;
    b.chain = new Promise((resolve) => {
      unlock = resolve;
    });
    await previous;

    // Global pause from a 429 with global=true.
    while (this.globalResetAt > Date.now()) {
      const wait = this.globalResetAt - Date.now();
      this.stats.waitMs += wait;
      await sleep(wait);
    }

    await this.sem.acquire();

    // Per-bucket exhaustion.
    if (b.remaining <= 0 && b.resetAt > Date.now()) {
      const wait = b.resetAt - Date.now();
      this.stats.waitMs += wait;
      await sleep(wait);
      b.remaining = Number.isFinite(b.limit) ? b.limit : 1;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.sem.release();
      unlock();
    };
  }

  record(routeKey, method, pathname, response) {
    const headers = response.headers;
    const bucketHash = headers.get('x-ratelimit-bucket');
    let bucketKey = this.routeToBucket.get(routeKey) ?? routeKey;

    if (bucketHash) {
      const majorMatch = pathname.match(/\/(\d{16,20})(?=\/|\?|$)/);
      const major = majorMatch ? majorMatch[1] : '';
      const learned = `${bucketHash}:${major}`;
      const previousKey = this.routeToBucket.get(routeKey);
      if (previousKey !== learned) {
        this.routeToBucket.set(routeKey, learned);
        const old = previousKey ? this.buckets.get(previousKey) : null;
        const next = this.bucket(learned);
        if (old && old !== next) {
          next.remaining = Math.min(next.remaining, old.remaining);
          next.resetAt = Math.max(next.resetAt, old.resetAt);
          next.limit = Math.min(next.limit, old.limit);
        }
      }
      bucketKey = learned;
    }

    const b = this.bucket(bucketKey);
    const remaining = headers.get('x-ratelimit-remaining');
    const resetAfter = headers.get('x-ratelimit-reset-after');
    const limit = headers.get('x-ratelimit-limit');

    if (resetAfter !== null) b.resetAt = Date.now() + parseFloat(resetAfter) * 1000;
    if (remaining !== null) b.remaining = parseInt(remaining, 10);
    if (limit !== null) b.limit = parseInt(limit, 10);

    if (headers.get('x-ratelimit-global') === 'true') {
      const ra = parseFloat(headers.get('retry-after') ?? '1');
      this.globalResetAt = Math.max(this.globalResetAt, Date.now() + ra * 1000 + 250);
    }
  }

  async request(method, pathname, opts = {}) {
    const { body, form, headers = {}, auth = true, retries = 7 } = opts;
    const routeKey = this.routeKey(method, pathname);
    const url = API_BASE + pathname;
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const release = await this.acquire(routeKey);
      let response;
      try {
        this.stats.requests++;
        const h = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
        if (auth) h.Authorization = this.token;
        if (!form && body !== undefined) h['Content-Type'] = 'application/json';
        Object.assign(h, headers);

        response = await fetch(url, {
          method,
          headers: h,
          body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
        });
      } catch (error) {
        release();
        lastError = error;
        if (attempt >= retries) throw error;
        this.stats.retries++;
        await sleep(400 * 2 ** attempt + Math.random() * 250);
        continue;
      }

      this.record(routeKey, method, pathname, response);
      release();
      this.onRequest(this.stats);

      if (response.status === 429) {
        this.stats.hits429++;
        let retryAfter = 1;
        let global = false;
        try {
          const payload = await response.json();
          if (typeof payload.retry_after === 'number') retryAfter = payload.retry_after;
          global = payload.global === true;
        } catch {
          const header = response.headers.get('retry-after');
          const parsed = header ? parseFloat(header) : NaN;
          if (Number.isFinite(parsed)) retryAfter = parsed;
        }
        if (!Number.isFinite(retryAfter) || retryAfter < 0) retryAfter = 1;

        const scope = response.headers.get('x-ratelimit-scope') || (global ? 'global' : 'user');
        const waitMs = retryAfter * 1000;
        const cap = opts.maxWaitMs ?? this.maxWaitMs;

        this.onRateLimit({ method, path: pathname, retryAfter, global, scope, attempt });

        const bucketKey = this.routeToBucket.get(routeKey) ?? routeKey;
        const b = this.bucket(bucketKey);

        if (global) {
          this.globalResetAt = Math.max(this.globalResetAt, Date.now() + waitMs + 250);
        }

        // A 429 whose reset is longer than the cap means this resource is parked.
        // Retrying it would stall the whole queue, so hand it back to the caller
        // and leave the bucket usable for a fresh attempt later.
        if (waitMs > cap || attempt >= retries) {
          if (global) this.globalResetAt = 0;
          b.resetAt = 0;
          b.remaining = Number.isFinite(b.limit) ? b.limit : 1;
          throw new RateLimitError(method, pathname, retryAfter, scope);
        }

        b.remaining = 0;
        b.resetAt = Math.max(b.resetAt, Date.now() + waitMs + 60);

        await sleep(waitMs + 120 + Math.random() * 180);
        continue;
      }

      if (response.status >= 500) {
        lastError = new HttpError(response.status, null, method, pathname);
        if (attempt >= retries) throw lastError;
        this.stats.retries++;
        await sleep(500 * 2 ** Math.min(attempt, 5) + Math.random() * 300);
        continue;
      }

      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      if (!response.ok) throw new HttpError(response.status, data, method, pathname);
      return data;
    }

    throw lastError ?? new Error(`${method} ${pathname} failed`);
  }

  get(pathname, opts) {
    return this.request('GET', pathname, opts);
  }
  post(pathname, body, opts = {}) {
    return this.request('POST', pathname, { ...opts, body });
  }
  patch(pathname, body, opts = {}) {
    return this.request('PATCH', pathname, { ...opts, body });
  }
  put(pathname, body, opts = {}) {
    return this.request('PUT', pathname, { ...opts, body });
  }
  delete(pathname, opts) {
    return this.request('DELETE', pathname, opts);
  }

  upload(pathname, fields, file) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) form.append(key, String(value));
    }
    form.append('file', new Blob([file.buffer], { type: file.contentType }), file.name);
    return this.request('POST', pathname, { form });
  }

  executeWebhook(webhookId, webhookToken, payload, files = [], opts = {}) {
    const query = new URLSearchParams();
    if (opts.threadId) query.set('thread_id', opts.threadId);
    if (opts.wait) query.set('wait', 'true');
    const suffix = query.toString() ? `?${query}` : '';
    const pathname = `/webhooks/${webhookId}/${webhookToken}${suffix}`;

    if (files.length === 0) {
      return this.request('POST', pathname, { body: payload, auth: false });
    }
    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload));
    files.forEach((file, index) => {
      form.append(
        `files[${index}]`,
        new Blob([file.buffer], { type: file.contentType }),
        file.name,
      );
    });
    return this.request('POST', pathname, { form, auth: false });
  }
}
