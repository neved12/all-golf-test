#!/usr/bin/env node
/* ALL:GOLF 전국 골프장 데이터 무결성 테스트
   실행: node tests/national-data-integrity.js
   - 실제 화면·서버가 읽는 data/*.js 를 그대로 실행해 마스터 품질을 검사한다.
   - 공식 출처(문체부·행안부·협회) 병합 결과의 중복·누락·오염 여부를 본다.
   - 실패가 있으면 종료 코드 1을 돌려준다. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rootDir = path.join(__dirname, '..');
const FILES = ['data/national-golf-courses.js', 'data/golf-courses.js', 'data/demo-teetimes.js'];
const REGION_CODES = ['서울', '경기', '인천', '강원', '충북', '충남', '대전', '세종', '전북', '전남', '광주', '경북', '경남', '대구', '울산', '부산', '제주'];
const NON_COURSE_NAME = /연습장|스크린|실내|당구|파3|파 3|간이|어프로치|시뮬레|인도어/;

const sandbox = { window: {}, console: { log() {}, warn() {}, error() {} }, Date, Math, JSON, Number, String, Object, Array, Set, Map, Intl };
vm.createContext(sandbox);
for (const file of FILES) {
  vm.runInContext(fs.readFileSync(path.join(rootDir, file), 'utf8'), sandbox, { filename: file });
}
const win = sandbox.window;
const national = win.ALL_GOLF_NATIONAL_COURSES || [];
const metadata = win.ALL_GOLF_NATIONAL_METADATA || {};
const courses = win.ALL_GOLF_COURSES || [];
const regions = win.ALL_GOLF_REGIONS || [];
const demoStock = win.ALL_GOLF_DEMO_COURSES || {};

const results = [];
const ok = (name, condition, detail = '') => results.push({ name, ok: Boolean(condition), detail: String(detail) });
const eq = (name, actual, expected) => ok(name, actual === expected, `기대 ${JSON.stringify(expected)} / 실제 ${JSON.stringify(actual)}`);
const section = title => results.push({ name: `# ${title}`, ok: true, detail: '', heading: true });

const countBy = (list, key) => list.reduce((acc, item) => { const value = typeof key === 'function' ? key(item) : item[key]; acc[value] = (acc[value] || 0) + 1; return acc; }, {});

/* 1) 전국 마스터 규모·구성 */
section('전국 마스터 규모');
ok('전국 레코드 500곳 이상', national.length >= 500, `${national.length}곳`);
eq('메타데이터 count 일치', metadata.count, national.length);
ok('공식 출처 3종 기록', Array.isArray(metadata.sources) && metadata.sources.length === 3, JSON.stringify((metadata.sources || []).map(item => item && item.url)));
ok('기준일 기록', Boolean(metadata.sourceAsOf), metadata.sourceAsOf);
ok('생성 시각 기록', Boolean(metadata.generatedAt), metadata.generatedAt);

const ids = national.map(item => item.id);
eq('중복 ID 0건', ids.length - new Set(ids).size, 0);
eq('중복 없음(화면 마스터)', courses.length - new Set(courses.map(item => item.id)).size, 0);
ok('화면 마스터가 전국 마스터를 포함', courses.length >= national.length, `${courses.length} / ${national.length}`);

/* 2) 필수 필드 */
section('필수 필드');
const missingName = national.filter(item => !item.name || !String(item.name).trim());
const missingRegion = national.filter(item => !REGION_CODES.includes(item.region));
const missingCity = national.filter(item => !item.city || !String(item.city).trim());
const missingAddress = national.filter(item => !item.address);
const missingSource = national.filter(item => !Array.isArray(item.sources) || !item.sources.length);
eq('이름 누락 0건', missingName.length, 0);
eq('17개 시·도 밖 지역 0건', missingRegion.length, 0);
eq('시·군 누락 0건', missingCity.length, 0);
ok('주소 누락 1건 이하', missingAddress.length <= 1, `${missingAddress.length}건: ${missingAddress.map(item => item.name).join(', ')}`);
eq('출처 없는 레코드 0건', missingSource.length, 0);
const activeAll = national.every(item => item.operatingStatus === 'active');
ok('모든 레코드가 영업중 상태', activeAll, national.filter(item => item.operatingStatus !== 'active').map(item => `${item.name}:${item.operatingStatus}`).join(', '));
const badHoles = national.filter(item => item.holes != null && (!Number.isFinite(item.holes) || item.holes < 6));
eq('홀수 이상값 0건', badHoles.length, 0);
const unverifiedMode = national.filter(item => item.bookingStatus !== 'info' || item.dataMode !== 'official_info');
eq('정보 전용 레코드는 bookingStatus=info, dataMode=official_info', unverifiedMode.length, 0);

/* 3) 지역 분포·서울 포함 */
section('지역 분포');
const regionCounts = countBy(national, 'region');
const emptyRegions = REGION_CODES.filter(code => !regionCounts[code]);
eq('17개 시·도 모두 1곳 이상', emptyRegions.length, 0);
ok('서울 골프장 포함', (regionCounts['서울'] || 0) >= 1, `서울 ${regionCounts['서울'] || 0}곳`);
const regionOptionCodes = regions.map(region => region.code);
eq('지역 필터 코드와 데이터 일치', REGION_CODES.filter(code => !regionOptionCodes.includes(code)).length, 0);
const seoul = national.filter(item => item.region === '서울');
ok('서울 레코드 상세 주소 보유', seoul.every(item => item.address && item.city), seoul.map(item => `${item.name}(${item.city})`).join(', '));
ok('경기 120곳 이상', (regionCounts['경기'] || 0) >= 120, `경기 ${regionCounts['경기'] || 0}곳`);
ok('강원 55곳 이상', (regionCounts['강원'] || 0) >= 55, `강원 ${regionCounts['강원'] || 0}곳`);
ok('제주 25곳 이상', (regionCounts['제주'] || 0) >= 25, `제주 ${regionCounts['제주'] || 0}곳`);
ok('전남 35곳 이상', (regionCounts['전남'] || 0) >= 35, `전남 ${regionCounts['전남'] || 0}곳`);

/* 4) 시연 예약 68곳 보존 */
section('시연 예약 68곳 보존');
const demoCourses = courses.filter(item => item.bookingStatus === 'demo');
eq('화면 마스터의 시연 예약 골프장 68곳', demoCourses.length, 68);
const demoCatalog = national.filter(item => item.demoCatalog);
eq('전국 마스터에 시연 골프장 68곳 포함', demoCatalog.length, 68);
const demoStockIds = Object.keys(demoStock).filter(id => demoStock[id] && demoStock[id].generatedDemo === false);
eq('시연 재고 정의 68곳 유지', demoStockIds.length, 68);
const demoIds = demoCourses.map(item => item.id);
eq('시연 골프장 ID 중복 0건', demoIds.length - new Set(demoIds).size, 0);
ok('기존 시연 ID 그대로 유지', ['woojeong', 'emerson', 'princess', 'cn-golden-bay', 'cb-cheonryong', 'sj-field', 'dj-yuseong'].every(id => demoIds.includes(id)), demoIds.slice(0, 5).join(', '));
const brokenDemo = demoCourses.filter(item => !demoStock[item.id] || demoStock[item.id].generatedDemo !== false);
eq('시연 골프장 모두 시연 재고 보유', brokenDemo.length, 0);
const noTimes = demoCourses.filter(item => !(demoStock[item.id] && Array.isArray(demoStock[item.id].demoTeeTimes) && demoStock[item.id].demoTeeTimes.length));
eq('시연 골프장 티타임 연결', noTimes.length, 0, noTimes.map(item => item.name).join(', '));

/* 5) 폐업·연습장 등 오염 방지 */
section('오염 방지');
const nonCourse = courses.filter(item => NON_COURSE_NAME.test(String(item.name)));
eq('연습장·스크린·실내·파3 명칭 0건', nonCourse.length, 0);
const placeholder = courses.filter(item => ['미사용', '테스트', '송산'].includes(String(item.name).trim()));
eq('플레이스홀더 명칭 0건', placeholder.length, 0);
const infoCourses = courses.filter(item => item.bookingStatus !== 'demo');
ok('정보 전용 골프장에 요금·티타임 없음', infoCourses.every(item => !item.greenFee && !item.verifiedGreenFee && !item.officialBookingUrl), infoCourses.filter(item => item.greenFee || item.verifiedGreenFee).map(item => item.name).join(', '));
eq('정보 전용 골프장은 예약 미지원 표시', infoCourses.filter(item => item.bookable).length, 0);
const dupKey = new Map();
let dupPair = '';
for (const item of courses) {
  const key = `${String(item.name).replace(/\([^)]*\)/g, '').replace(/[\s()]/g, '')}|${item.city}`;
  if (dupKey.has(key)) dupPair = `${dupKey.get(key)} / ${item.name}`;
  dupKey.set(key, item.name);
}
ok('같은 시·군 중복 골프장 없음', !dupPair, dupPair);

/* 6) 정리 규칙 산출물 */
section('정리 규칙·보고서');
const reportPath = path.join(rootDir, 'data', 'national-build-report.json');
if (fs.existsSync(reportPath)) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  eq('보고서 총계와 데이터 일치', report.total, national.length);
  ok('수동 병합 근거 기록', Array.isArray(report.manualMerges) && report.manualMerges.length >= 20, `${(report.manualMerges || []).length}건`);
  ok('제외 라이선스 근거 기록', Array.isArray(report.excludedLicenses) && report.excludedLicenses.every(item => item.reason), `${(report.excludedLicenses || []).length}건`);
} else {
  ok('생성 보고서 존재', false, reportPath);
}

/* 결과 출력 */
let passed = 0;
let failed = 0;
for (const item of results) {
  if (item.heading) { console.log(`\n${item.name}`); continue; }
  if (item.ok) passed += 1; else failed += 1;
  console.log(`${item.ok ? '  ✓' : '  ✗'} ${item.name}${item.ok || !item.detail ? '' : `\n      → ${item.detail}`}`);
}
console.log(`\n결과: ${passed}/${passed + failed} 통과, ${failed} 실패`);
if (failed > 0) process.exitCode = 1;
