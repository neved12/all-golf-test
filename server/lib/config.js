'use strict';
/* ALL:GOLF 서버 설정
   - 외부 의존성 없이 .env 파일을 직접 읽는다.
   - 비밀값이 없으면 시연용 기본값으로 동작하고, 시작할 때 경고를 남긴다. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rootDir = path.resolve(__dirname, '..', '..');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return false;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  /* Windows 메모장이 붙이는 BOM 을 제거한다(첫 줄 키가 무시되지 않도록). */
  text = text.replace(/^\uFEFF/, '');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

const envFiles = [path.join(rootDir, '.env'), path.join(rootDir, 'server', '.env')];
const loadedEnvFiles = envFiles.filter(loadEnvFile);

/* 시연용 기본 비밀번호. 실제 운영 비밀번호가 아니며, 저장소에 공개되어 있어도
   운영 계정으로 쓸 수 없도록 문서·로그에서 "시연용"임을 항상 함께 표시한다. */
const DEMO_ADMIN_PASSWORD = 'allgolf-demo-2026';

const adminPassword = String(process.env.ADMIN_PASSWORD || '').trim() || DEMO_ADMIN_PASSWORD;
const usingDefaultPassword = !String(process.env.ADMIN_PASSWORD || '').trim();
const sessionSecret = String(process.env.SESSION_SECRET || '').trim() || crypto.randomBytes(32).toString('hex');
const usingEphemeralSecret = !String(process.env.SESSION_SECRET || '').trim();

const allowedOrigins = String(process.env.ALLGOLF_ALLOWED_ORIGINS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

module.exports = {
  rootDir,
  loadedEnvFiles,
  port: Number(process.env.PORT || 4173),
  host: process.env.HOST || '127.0.0.1',
  adminPassword,
  usingDefaultPassword,
  DEMO_ADMIN_PASSWORD,
  adminEmail: String(process.env.ADMIN_EMAIL || 'admin@allgolf.demo').trim().toLowerCase(),
  sessionSecret,
  usingEphemeralSecret,
  sessionTtlMs: Number(process.env.SESSION_TTL_HOURS || 8) * 60 * 60 * 1000,
  /* 골프장 담당자 세션: 본사 관리자와 별도 쿠키/토큰 접두사를 쓰고 만료를 따로 둘 수 있다. */
  partnerSessionTtlMs: Number(process.env.PARTNER_SESSION_TTL_HOURS || 12) * 60 * 60 * 1000,
  /* 시연용 담당자 계정 자동 생성(선택). 꺼 두면 본사 관리자 화면/스크립트로만 만든다. */
  seedDemoPartnerAccounts: String(process.env.ALLGOLF_SEED_DEMO_PARTNER_ACCOUNTS || '').toLowerCase() === '1',
  demoPartnerPassword: String(process.env.DEMO_PARTNER_PASSWORD || '').trim() || 'allgolf-partner-2026',
  dbPath: process.env.ALLGOLF_DB_PATH
    ? path.resolve(rootDir, process.env.ALLGOLF_DB_PATH)
    : path.join(rootDir, 'server', 'data', 'db.json'),
  backupDir: process.env.ALLGOLF_BACKUP_DIR
    ? path.resolve(rootDir, process.env.ALLGOLF_BACKUP_DIR)
    : path.join(rootDir, 'server', 'data', 'backups'),
  disableAutoBackup: String(process.env.ALLGOLF_BACKUP || '').toLowerCase() === 'off',
  secureCookie: String(process.env.ALLGOLF_SECURE_COOKIE || '') === '1',
  allowedOrigins,
  serveStatic: String(process.env.ALLGOLF_STATIC || '').toLowerCase() !== 'off',
  version: require(path.join(rootDir, 'package.json')).version,
  serverName: 'ALL:GOLF API'
};
