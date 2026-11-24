#!/usr/bin/env node
'use strict';
/* 시연 DB 초기화: npm run db:reset-demo
   모든 제휴 신청·승인 이력을 지운다. 확인 문구 RESET 을 입력해야 진행한다. */

const fs = require('fs');
const readline = require('readline');
const config = require('../lib/config');
const { Store, emptyDatabase } = require('../lib/db');

(async () => {
  const store = new Store({ file: config.dbPath, backupDir: config.backupDir });
  store.init();
  const status = store.status();
  console.log(`현재 DB: 신청 ${status.applications}건 · 승인 골프장 ${status.approvedCourses}곳 · 이력 ${status.auditLogs}건`);
  console.log('이 명령은 모든 제휴 신청·승인 이력을 지웁니다. 계속하려면 RESET 을 입력하세요.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => rl.question('> ', resolve));
  rl.close();
  if (String(answer).trim() !== 'RESET') {
    console.log('취소했습니다.');
    return;
  }
  await store.backup('before-reset');
  const fresh = emptyDatabase();
  fs.writeFileSync(config.dbPath, `${JSON.stringify(fresh, null, 2)}\n`);
  console.log('DB 를 초기화했습니다. (초기화 전 데이터는 backups/ 에 보관)');
})().catch(error => {
  console.error('초기화 실패:', error.message);
  process.exit(1);
});
