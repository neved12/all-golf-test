#!/usr/bin/env node
'use strict';
/* 백업 복구: npm run db:restore -- server/data/backups/db-2026-11-24.json
   복구 전 현재 DB 는 backups/db-before-restore-*.json 으로 자동 보존된다. */

const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const { Store } = require('../lib/db');

(async () => {
  const store = new Store({ file: config.dbPath, backupDir: config.backupDir });
  store.init();
  const target = process.argv[2];
  if (!target) {
    console.log('사용법: npm run db:restore -- <백업 파일 경로>');
    if (fs.existsSync(config.backupDir)) {
      const files = fs.readdirSync(config.backupDir).filter(name => name.endsWith('.json')).sort().reverse().slice(0, 10);
      console.log('\n사용 가능한 백업:');
      files.forEach(name => console.log(`  server/data/backups/${name}`));
    }
    process.exit(1);
  }
  const result = await store.restore(path.resolve(target));
  console.log(`복구 완료: ${result.restoredFrom}`);
  console.log(`신청 ${result.counts.applications}건`);
})().catch(error => {
  console.error('복구 실패:', error.message);
  process.exit(1);
});
