#!/usr/bin/env node
'use strict';
/* 시연용 골프장 담당자 계정 생성: npm run demo:partner-accounts [-- 비밀번호]
   - 제휴 승인된 골프장 중 아직 담당자 계정이 없는 곳에 하나씩 만든다.
   - 실제 운영에서는 이 스크립트를 쓰지 말고 본사 관리자 화면에서 계정을 만든다.
   - 화면과 달리 여기서는 콘솔에 초기 비밀번호를 한 번 출력한다(시연 편의용). */

const config = require('../lib/config');
const { Store } = require('../lib/db');
const accounts = require('../lib/accounts');

(async () => {
  const password = String(process.argv[2] || config.demoPartnerPassword);
  const problem = accounts.passwordProblem(password);
  if (problem) {
    console.error(`비밀번호를 사용할 수 없습니다: ${problem}`);
    process.exit(1);
  }
  const store = new Store({ file: config.dbPath, backupDir: config.backupDir });
  store.init();
  const { result: made } = await store.update(db => accounts.seedDemoAccounts(db, { password }));
  if (!made.length) {
    console.log('새로 만들 계정이 없습니다. (제휴 승인 골프장이 없거나 모두 계정이 있음)');
    return;
  }
  console.log(`시연용 담당자 계정 ${made.length}개를 만들었습니다. 아래 초기 비밀번호는 이 순간에만 출력됩니다.`);
  made.forEach(({ account }) => {
    console.log(`  ${account.email}  /  ${password}  (${account.courseName || account.courseId})`);
  });
  console.log('\n실제 운영에서는 본사 관리자 화면에서 계정을 만들고 .env 의 DEMO 계정을 쓰지 마세요.');
})().catch(error => {
  console.error('계정 생성 실패:', error.message);
  process.exit(1);
});
