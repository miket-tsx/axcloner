import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { fetchPreview, cloneServer } from './lib/cloner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 4080;
const HOST = process.env.HOST || '0.0.0.0';
const VERSION = '1.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const jobs = new Map();
const JOB_TTL_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.done && now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}, 60 * 1000).unref();

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid JSON body');
  }
}

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    json(res, 403, { error: 'forbidden' });
    return;
  }
  try {
    const data = await readFile(resolved);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

function broadcast(job, event) {
  job.events.push(event);
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of job.clients) {
    try {
      client.write(frame);
    } catch {
      /* client gone */
    }
  }
}

function startJob({ token, sourceId, targetId, options }) {
  const id = randomUUID();
  const job = {
    id,
    events: [],
    clients: new Set(),
    done: false,
    createdAt: Date.now(),
    controller: new AbortController(),
  };
  jobs.set(id, job);

  job.events.push({ type: 'log', level: 'info', message: 'job accepted — starting' });

  cloneServer({
    token,
    sourceId,
    targetId,
    options,
    signal: job.controller.signal,
    emit: (event) => broadcast(job, event),
  })
    .then((summary) => broadcast(job, { type: 'done', summary }))
    .catch((error) => {
      if (error?.name === 'AbortedError') {
        broadcast(job, { type: 'error', message: 'clone aborted by operator' });
      } else {
        broadcast(job, {
          type: 'error',
          message: error?.message || 'unknown error',
          details: error?.body ?? null,
          status: error?.status ?? null,
        });
      }
    })
    .finally(() => {
      job.done = true;
      for (const client of job.clients) {
        try {
          client.end();
        } catch {
          /* ignore */
        }
      }
      job.clients.clear();
    });

  return id;
}

async function handleApi(req, res, url) {
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/api/info') {
    json(res, 200, {
      name: 'AXCLONER',
      version: VERSION,
      author: 'axyers team (mikey)',
      node: process.version,
      endpoints: ['/api/preview', '/api/clone', '/api/stream/:id', '/api/job/:id/cancel'],
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/preview') {
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      json(res, 400, { error: error.message });
      return;
    }
    const { token, sourceId, targetId } = body;
    if (!token || typeof token !== 'string') {
      json(res, 400, { error: 'token is required' });
      return;
    }
    if (!sourceId || !/^\d{16,20}$/.test(String(sourceId))) {
      json(res, 400, { error: 'valid source server id is required' });
      return;
    }
    if (targetId && !/^\d{16,20}$/.test(String(targetId))) {
      json(res, 400, { error: 'target server id must be a snowflake' });
      return;
    }
    try {
      const preview = await fetchPreview({
        token: token.trim(),
        sourceId: String(sourceId),
        targetId: targetId ? String(targetId) : null,
      });
      json(res, 200, preview);
    } catch (error) {
      json(res, error?.status === 401 ? 401 : 400, {
        error: error?.message || 'preview failed',
        status: error?.status ?? null,
        details: error?.body ?? null,
      });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/clone') {
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      json(res, 400, { error: error.message });
      return;
    }
    const { token, sourceId, targetId, options = {} } = body;
    if (!token || typeof token !== 'string') {
      json(res, 400, { error: 'token is required' });
      return;
    }
    if (!/^\d{16,20}$/.test(String(sourceId ?? '')) || !/^\d{16,20}$/.test(String(targetId ?? ''))) {
      json(res, 400, { error: 'source and target server ids are required' });
      return;
    }
    if (String(sourceId) === String(targetId)) {
      json(res, 400, { error: 'source and target must differ' });
      return;
    }
    const jobId = startJob({
      token: token.trim(),
      sourceId: String(sourceId),
      targetId: String(targetId),
      options,
    });
    json(res, 200, { jobId });
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/stream/')) {
    const jobId = pathname.slice('/api/stream/'.length);
    const job = jobs.get(jobId);
    if (!job) {
      json(res, 404, { error: 'job not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    for (const event of job.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (job.done) {
      res.end();
      return;
    }
    job.clients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      job.clients.delete(res);
    });
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/api/job/') && pathname.endsWith('/cancel')) {
    const jobId = pathname.slice('/api/job/'.length, -'/cancel'.length);
    const job = jobs.get(jobId);
    if (!job) {
      json(res, 404, { error: 'job not found' });
      return;
    }
    job.controller.abort();
    json(res, 200, { cancelled: true });
    return;
  }

  json(res, 404, { error: 'unknown endpoint' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (error) {
    if (!res.headersSent) json(res, 500, { error: error?.message || 'internal error' });
    else res.end();
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[axcloner] unhandled rejection:', reason);
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log('');
  console.log('  AXCLONER  ·  by axyers team (mikey)');
  console.log(`  running  →  http://${shown}:${PORT}`);
  console.log(`  node     →  ${process.version}`);
  console.log('');
});
