#!/usr/bin/env node
/* ALL:GOLF 시나리오 회귀 테스트 실행기
   사용법: node tests/run-scenarios.js
   - 브라우저 없이 앱 코드를 그대로 실행한다.
   - 실패가 있으면 종료 코드 1을 돌려준다. */
'use strict';

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const files = [
  'tests/dom-shim.js',
  'data/national-golf-courses.js',
  'data/golf-courses.js',
  'data/demo-teetimes.js',
  'data/shared-store.js',
  'app.js',
  'tests/scenarios.js'
];

const source = files.map(file => `\n/* ===== ${file} ===== */\n${fs.readFileSync(path.join(rootDir, file), 'utf8')}`).join('\n');

// 한 스크립트로 이어 붙여 실행해야 앱의 최상위 let/const 상태를 테스트에서 그대로 다룰 수 있다.
const run = new Function(`${source}\nreturn __runScenarios();`);
const report = run();

let lastHeading = '';
for (const item of report.results) {
  if (item.heading) {
    lastHeading = item.name;
    console.log(`\n${item.name}`);
    continue;
  }
  const mark = item.ok ? '  ✓' : '  ✗';
  console.log(`${mark} ${item.name}${item.ok || !item.detail ? '' : `\n      → ${item.detail}`}`);
  void lastHeading;
}

console.log(`\n결과: ${report.passed}/${report.total} 통과, ${report.failed} 실패`);
if (report.failed > 0) process.exitCode = 1;
