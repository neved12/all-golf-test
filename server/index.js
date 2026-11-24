#!/usr/bin/env node
'use strict';
/* ALL:GOLF 7단계 서버
   사용법: node server/index.js   (= npm start)
   - 외부 패키지·네이티브 빌드 없이 Node.js 내장 모듈만 사용한다(Windows 무설치).
   - 같은 주소에서 정적 앱(/, /partner/, /admin/)과 /api 를 함께 제공한다.
   - GitHub Pages 처럼 서버가 없는 곳에서는 프론트엔드가 자동으로 정적 시연 모드로 동작한다. */

const http = require('http');
const os = require('os');

const config = require('./lib/config');
const { getCatalog } = require('./lib/catalog');
const { Store } = require('./lib/db');
const { Auth } = require('./lib/auth');
const { PartnerAuth } = require('./lib/partner-auth');
const accounts = require('./lib/accounts');
const { createApi } = require('./routes/api');
const helper = require('./lib/http');

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function lanAddresses() {
  const result = [];
  const interfaces = os.networkInterfaces();
  Object.keys(interfaces).forEach(name => {
    (interfaces[name] || []).forEach(item => {
      if (item && item.family === 'IPv4' && !item.internal) result.push(item.address);
    });
  });
  return result;
}

function createServer() {
  const catalog = getCatalog();
  const store = new Store({
    file: config.dbPath,
    backupDir: config.backupDir,
    autoBackup: !config.disableAutoBackup
  });
  store.init();
  const auth = new Auth({
    password: config.adminPassword,
    email: config.adminEmail,
    secret: config.sessionSecret,
    ttlMs: config.sessionTtlMs,
    usingDefaultPassword: config.usingDefaultPassword
  });
  const partnerAuth = new PartnerAuth({
    secret: config.sessionSecret,
    ttlMs: config.partnerSessionTtlMs
  });
  if (config.seedDemoPartnerAccounts) {
    try {
      const result = store.update(db => accounts.seedDemoAccounts(db, { password: config.demoPartnerPassword }));
      result.then(({ result: made }) => {
        if (made && made.length) {
          console.log(`[ALL:GOLF] 시연용 골프장 담당자 계정 ${made.length}개를 새로 만들었습니다(비밀번호 ${config.demoPartnerPassword}).`);
        }
      }).catch(error => console.error('[ALL:GOLF] 시연 계정 생성 실패:', error && error.message));
    } catch (error) {
      console.error('[ALL:GOLF] 시연 계정 생성 실패:', error && error.message);
    }
  }
  const api = createApi({ store, auth, partnerAuth, catalog, config });

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      helper.sendError(res, 400, 'bad_request', 'Bad request');
      return;
    }
    const method = req.method || 'GET';
    const corsOk = helper.applyCors(req, res, config.allowedOrigins);
    if (method === 'OPTIONS') {
      res.writeHead(corsOk ? 204 : 403, helper.baseHeaders(corsOk ? {} : {}));
      res.end();
      return;
    }
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        await api.dispatch(req, res, url);
      } else if (method === 'GET' || method === 'HEAD') {
        if (!config.serveStatic) {
          helper.sendError(res, 404, 'static_disabled', '정적 파일 서빙이 꺼져 있습니다(ALLGOLF_STATIC=off).');
        } else {
          helper.serveStatic(req, res, url.pathname, config.rootDir);
        }
      } else {
        helper.sendError(res, 405, 'method_not_allowed', '허용되지 않는 메서드입니다.');
      }
    } catch (error) {
      if (!res.headersSent) {
        helper.sendError(res, 500, error.code || 'internal_error', '서버 오류가 발생했습니다.');
      }
      console.error('[ALL:GOLF] 요청 처리 실패', error);
    } finally {
      if (url.pathname.startsWith('/api/')) {
        log(`${method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  });

  return { server, store, auth, api, catalog };
}

function start() {
  const { server, store, api, catalog } = createServer();

  server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      console.error(`\n포트 ${config.port} 이(가) 이미 사용 중입니다.`);
      console.error('다른 서버를 종료하거나 PORT=4174 npm start 처럼 다른 포트로 실행하세요.\n');
      process.exit(1);
    }
    console.error('[ALL:GOLF] 서버 오류:', error);
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : config.port;
    console.log('');
    console.log('  ALL:GOLF 7단계 서버 (시연용 · 실제 결제/예약 아님)');
    console.log(`  사용자 앱      http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}/`);
    console.log(`  골프장 관리자  http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}/partner/`);
    console.log(`  본사 관리자    http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}/admin/`);
    console.log(`  API 상태       http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}/api/health`);
    console.log(`  DB 파일        ${config.dbPath}`);
    console.log(`  골프장 마스터  ${catalog.courses.length}곳 · 기본 제휴 ${catalog.baselinePartnerIds.length}곳`);
    console.log(`  관리자 계정    ${config.adminEmail} / ${config.usingDefaultPassword ? `시연용 기본 비밀번호 ${config.DEMO_ADMIN_PASSWORD}` : '환경변수 ADMIN_PASSWORD'}`);
    console.log('  골프장 계정    본사 관리자 화면 > 제휴 계정 관리에서 생성 (골프장별 개별 로그인)');
    if (config.seedDemoPartnerAccounts) {
      console.log(`  시연 담당자    자동 생성 켜짐 · 비밀번호 ${config.demoPartnerPassword}`);
    }
    if (config.usingDefaultPassword) {
      console.log('  ⚠ 시연용 기본 비밀번호로 실행 중입니다. .env.example 을 복사해 ADMIN_PASSWORD 를 지정하세요.');
    }
    if (config.usingEphemeralSecret) {
      console.log('  ⚠ SESSION_SECRET 미지정: 서버를 재시작하면 관리자 로그인이 모두 만료됩니다.');
    }
    if (config.host === '0.0.0.0') {
      lanAddresses().forEach(address => console.log(`  같은 네트워크  http://${address}:${port}/`));
      console.log('  ⚠ 0.0.0.0 바인딩은 같은 네트워크의 다른 기기에서 접속할 수 있습니다. 시연용으로만 사용하세요.');
    }
    console.log('  종료: Ctrl+C');
    console.log('');
  });

  let closing = false;
  const shutdown = signal => {
    if (closing) return;
    closing = true;
    console.log(`\n[ALL:GOLF] ${signal} 수신, 서버를 종료합니다.`);
    server.close(() => {
      try { store.read(); } catch { /* noop */ }
      process.exit(0);
    });
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', error => console.error('[ALL:GOLF] 처리되지 않은 비동기 오류:', error));
}

if (require.main === module) {
  try {
    start();
  } catch (error) {
    console.error('\n[ALL:GOLF] 서버를 시작하지 못했습니다.');
    console.error(error && error.message ? error.message : error);
    if (error && error.code === 'DB_CORRUPT') {
      console.error('DB 를 초기화하지 않고 중단했습니다. 위 안내에 따라 백업에서 복구하세요.');
    }
    process.exit(1);
  }
}

module.exports = { createServer, start };
