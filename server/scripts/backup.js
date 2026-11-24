#!/usr/bin/env node
'use strict';
/* 수동 백업: npm run db:backup */

const config = require('../lib/config');
const { Store } = require('../lib/db');

(async () => {
  const store = new Store({ file: config.dbPath, backupDir: config.backupDir });
  store.init();
  const target = await store.backup('manual');
  const status = store.status();
  console.log(`백업 완료: ${target}`);
  console.log(`신청 ${status.applications}건 · 승인 골프장 ${status.approvedCourses}곳 · 담당자 계정 ${status.partnerAccounts}개 · 티타임 ${status.teeTimes}건 · 이력 ${status.auditLogs}건`);
})().catch(error => {
  console.error('백업 실패:', error.message);
  process.exit(1);
});
