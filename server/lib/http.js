'use strict';
/* HTTP 공통 유틸: JSON 응답, 본문 파싱, CORS, 보안 헤더, 정적 파일 서빙 */

const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.ics': 'text/calendar; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2'
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN'
};

function baseHeaders(extra) {
  return { ...SECURITY_HEADERS, ...(extra || {}) };
}

function sendJson(res, status, data, headers) {
  const body = `${JSON.stringify(data)}\n`;
  res.writeHead(status, baseHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...(headers || {})
  }));
  res.end(body);
}

function sendError(res, status, code, message, details, headers) {
  sendJson(res, status, { ok: false, error: { code, message, ...(details ? { details } : {}) }, message }, headers);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        const failure = new Error('요청 본문이 너무 큽니다.');
        failure.status = 413;
        failure.code = 'body_too_large';
        reject(failure);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      const failure = new Error('JSON 객체 형식이어야 합니다.');
      failure.status = 400;
      failure.code = 'invalid_json';
      throw failure;
    }
    return value;
  } catch (error) {
    if (error.status) throw error;
    const failure = new Error('JSON 형식이 올바르지 않습니다.');
    failure.status = 400;
    failure.code = 'invalid_json';
    throw failure;
  }
}

function applyCors(req, res, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const allowed = allowedOrigins.includes('*') || allowedOrigins.includes(origin);
  if (!allowed) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function parseCookies(header) {
  const result = {};
  String(header || '').split(';').forEach(part => {
    const index = part.indexOf('=');
    if (index < 1) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  });
  return result;
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

const BLOCKED_PREFIXES = ['/server', '/.git', '/node_modules', '/.github', '/.env'];

function isBlockedPath(pathname) {
  return BLOCKED_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))
    || /(^|\/)\.env(\.|$)/.test(pathname)
    || pathname.includes('/.');
}

function injectServerFlag(html) {
  if (html.includes('ALL_GOLF_SERVER_MODE')) return html;
  const snippet = '<meta name="allgolf-api" content="server"><script>window.ALL_GOLF_SERVER_MODE=true;</script>';
  if (html.includes('</head>')) return html.replace('</head>', `${snippet}</head>`);
  return `${snippet}${html}`;
}

function serveStatic(req, res, pathname, rootDir, options = {}) {
  if (isBlockedPath(pathname)) {
    sendError(res, 404, 'not_found', 'Not found');
    return;
  }
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch {
    sendError(res, 400, 'bad_path', 'Bad request');
    return;
  }
  /* 퍼센트 인코딩으로 /server, /.git 같은 경로를 우회하지 못하게 한 번 더 검사한다. */
  if (isBlockedPath(decoded) || decoded.split('/').some(part => part.startsWith('.'))) {
    sendError(res, 404, 'not_found', 'Not found');
    return;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  let filePath = path.resolve(rootDir, relative);
  if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) {
    sendError(res, 403, 'forbidden', 'Forbidden');
    return;
  }
  let stat;
  try { stat = fs.statSync(filePath); } catch {
    sendError(res, 404, 'not_found', `Not found: ${decoded}`);
    return;
  }
  if (stat.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    try { stat = fs.statSync(filePath); } catch {
      sendError(res, 404, 'not_found', `Not found: ${decoded}`);
      return;
    }
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  let body;
  try { body = fs.readFileSync(filePath); } catch {
    sendError(res, 500, 'read_failed', '파일을 읽을 수 없습니다.');
    return;
  }
  if (ext === '.html' && options.serverFlag !== false) {
    body = Buffer.from(injectServerFlag(body.toString('utf8')), 'utf8');
  }
  const headers = baseHeaders({
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=0, must-revalidate'
  });
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

function openSse(res) {
  res.writeHead(200, baseHeaders({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  }));
  res.write(': connected\n\n');
  return {
    send(event, data) {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        return true;
      } catch { return false; }
    },
    ping() { try { res.write(': ping\n\n'); } catch { /* noop */ } },
    close() { try { res.end(); } catch { /* noop */ } }
  };
}

module.exports = {
  MIME,
  SECURITY_HEADERS,
  baseHeaders,
  sendJson,
  sendError,
  readBody,
  readJson,
  applyCors,
  clientIp,
  parseCookies,
  bearerToken,
  isBlockedPath,
  injectServerFlag,
  serveStatic,
  openSse
};
