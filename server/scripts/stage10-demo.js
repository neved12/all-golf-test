#!/usr/bin/env node
'use strict';
/* ALL:GOLF 10단계 — 원클릭 시연 데이터 CLI
   사용법:
     npm run demo:stage10                시연 데이터 준비(이전 10단계 시연 배치만 지우고 새로 만든다)
     npm run demo:stage10 -- status      현재 시연/일반 데이터 개수 확인
     npm run demo:stage10 -- reset       시연 데이터 초기화(확인 필요: 대화형 RESET 입력 또는 --yes)
     npm run demo:stage10 -- reset --dry-run   삭제 대상만 미리 보기

   안전 원칙:
   - 이 스크립트가 만드는 레코드는 demoStage='stage10' 태그가 붙는다.
   - reset 은 그 태그가 붙은 레코드만 지운다. 태그가 없는 일반 데이터는 지우지 않는다.
   - reset 은 터미널에서 RESET 을 입력해야 실행되고, 비대화형(파이프·테스트)에서는 --yes 가 있어야 한다. */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const config = require('../lib/config');
const { Store } = require('../lib/db');
const { getCatalog } = require('../lib/catalog');
const demoStage10 = require('../lib/demo-stage10');

const args = process.argv.slice(2).map(value => String(value).toLowerCase());
const command = ['status', 'reset', 'stage'].find(name => args.includes(name)) || 'stage';
const assumeYes = args.includes('--yes') || args.includes('-y');
const dryRun = args.includes('--dry-run');

function line(label, value) {
  console.log(`  ${label.padEnd(22, ' ')} ${value}`);
}

function printStatus(status) {
  console.log('\n현재 DB 시연 데이터(10단계 태그 기준)');
  line('배치', status.batch || '(없음)');
  line('준비 시각', status.stagedAt || '(없음)');
  line('시연 골프장', `${status.demo.approvedCourses}곳`);
  line('시연 티타임', `${status.demo.teeTimes}건`);
  line('시연 담당자 계정', `${status.demo.partnerAccounts}개`);
  line('시연 예약', `${status.demo.reservations}건`);
  line('시연 정산서', `${status.demo.settlements}건`);
  line('시연 알림 로그', `${status.demo.notificationLogs}건`);
  line('──────────────', '');
  line('보존 대상(일반)', `골프장 ${status.protectedRecords.approvedCourses}곳 · 티타임 ${status.protectedRecords.teeTimes}건 · 계정 ${status.protectedRecords.partnerAccounts}개 · 예약 ${status.protectedRecords.reservations}건 · 정산 ${status.protectedRecords.settlements}건 · 신청 ${status.protectedRecords.applications}건`);
  line('DB 파일', path.relative(process.cwd(), config.dbPath) || config.dbPath);
  console.log(`  ${status.statements.isolation}`);
  console.log(`  ${status.statements.notReal}\n`);
}

async function confirmReset(status) {
  console.log('\n다음을 삭제합니다(10단계 시연 태그가 붙은 레코드만)');
  line('시연 골프장', `${status.demo.approvedCourses}곳`);
  line('시연 티타임', `${status.demo.teeTimes}건`);
  line('시연 예약', `${status.demo.reservations}건`);
  line('시연 정산서', `${status.demo.settlements}건`);
  line('시연 계정', `${status.demo.partnerAccounts}개`);
  line('시연 알림·감사 로그', `${status.demo.notificationLogs + status.demo.auditLogs}건`);
  console.log(`\n일반 데이터(태그 없음) ${status.protectedTotal}건은 그대로 둡니다.`);
  if (!status.demoTotal) {
    console.log('삭제할 시연 데이터가 없습니다.');
    return false;
  }
  if (dryRun) {
    console.log('--dry-run: 아무것도 지우지 않았습니다.\n');
    return false;
  }
  if (assumeYes) {
    console.log('--yes 확인됨. 초기화를 진행합니다.\n');
    return true;
  }
  if (!process.stdin.isTTY) {
    console.log('비대화형 실행입니다. 실제로 초기화하려면 --yes 를 붙이세요: npm run demo:stage10 -- reset --yes\n');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => rl.question(`계속하려면 ${demoStage10.CONFIRM_RESET} 를 입력하세요: `, resolve));
  rl.close();
  if (String(answer).trim() !== demoStage10.CONFIRM_RESET) {
    console.log('입력이 일치하지 않아 취소했습니다.\n');
    return false;
  }
  return true;
}

(async () => {
  const store = new Store({ file: config.dbPath, backupDir: config.backupDir });
  store.init();
  const before = demoStage10.demoStatus(store.read());

  if (command === 'status') {
    printStatus(before);
    return;
  }

  if (command === 'reset') {
    if (!(await confirmReset(before))) return;
    await store.backup('before-stage10-reset');
    const { result } = await store.update(db => demoStage10.resetDemo(db, {
      confirm: demoStage10.CONFIRM_RESET,
      actor: { type: 'cli', note: 'npm run demo:stage10 -- reset' }
    }));
    console.log('10단계 시연 데이터를 초기화했습니다.');
    line('삭제 합계', `${result.removedTotal}건`);
    line('보존(일반) 합계', `${Object.values(result.preserved).reduce((total, value) => total + value, 0)}건`);
    console.log(`  초기화 전 DB 백업: ${config.backupDir}\n`);
    return;
  }

  /* stage: 이전 시연 배치를 정리하고 새로 준비한다(일반 데이터 불변). */
  const catalog = getCatalog();
  console.log('\n10단계 시연 데이터를 준비합니다.');
  line('골프장 마스터', `${catalog.courses.length}곳 (시연 예약 ${catalog.baselinePartnerIds.length}곳 + 정보 전용 ${catalog.courses.length - catalog.baselinePartnerIds.length}곳)`);
  line('시연 골프장', demoStage10.DEMO_COURSE_IDS.join(', '));
  line('예정 티타임', '3곳 × 7일 × 4시간 = 84건');
  if (before.demoTotal) {
    line('이전 시연 배치', `${before.batch} (${before.demoTotal}건을 정리하고 새로 만듭니다)`);
  }
  line('보존 대상(일반)', `${before.protectedTotal}건`);
  if (dryRun) {
    console.log('--dry-run: 아무것도 만들지 않았습니다.\n');
    return;
  }
  await store.backup('before-stage10-stage');
  const { result } = await store.update(db => demoStage10.stageDemo(db, {
    confirm: demoStage10.CONFIRM_STAGE,
    catalog,
    actor: { type: 'cli', note: 'npm run demo:stage10' }
  }));
  console.log('\n시연 데이터를 준비했습니다.');
  line('배치', result.batch);
  line('시연 골프장', `${result.created.approvedCourses}곳 (이미 승인된 골프장은 그대로 둠)`);
  line('티타임', `${result.created.teeTimes}건`);
  line('담당자 계정', `${result.created.partnerAccounts}개`);
  line('예약', `${result.created.reservations}건`);
  line('정산서', `${result.created.settlements}건`);
  line('담당자 비밀번호', result.partnerLogin.password);
  console.log('\n다음 단계: npm start  →  http://127.0.0.1:4173/demo/ 에서 시연을 시작하세요.');
  console.log(`서버가 이미 켜져 있으면 화면의 "시연 데이터 초기화" 패널에서도 같은 작업을 할 수 있습니다.\n`);
})().catch(error => {
  console.error('\n10단계 시연 데이터 작업 실패:', error && error.message ? error.message : error);
  if (error && error.code === 'confirm_required') console.error('안전 확인 문구가 필요합니다.');
  process.exit(1);
});
