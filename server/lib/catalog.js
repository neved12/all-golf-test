'use strict';
/* 골프장 마스터·지역·시연 재고 카탈로그
   프론트엔드와 같은 데이터 파일(data/*.js)을 Node vm 에서 그대로 실행해 읽는다.
   파일을 복사하지 않으므로 화면과 서버의 골프장 목록이 어긋나지 않는다. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rootDir = path.resolve(__dirname, '..', '..');
const DATA_FILES = [
  'data/national-golf-courses.js',
  'data/golf-courses.js',
  'data/demo-teetimes.js'
];

function loadCatalog() {
  const sandbox = { window: {}, console: { log() {}, warn() {}, error() {} }, Date, Math, JSON, Number, String, Object, Array, Set, Map, Intl };
  vm.createContext(sandbox);
  for (const file of DATA_FILES) {
    const source = fs.readFileSync(path.join(rootDir, file), 'utf8');
    vm.runInContext(source, sandbox, { filename: file, timeout: 10000 });
  }
  const win = sandbox.window;
  const courses = Array.isArray(win.ALL_GOLF_COURSES) ? win.ALL_GOLF_COURSES : [];
  const regions = Array.isArray(win.ALL_GOLF_REGIONS) ? win.ALL_GOLF_REGIONS : [];
  const demo = win.ALL_GOLF_DEMO_COURSES && typeof win.ALL_GOLF_DEMO_COURSES === 'object' ? win.ALL_GOLF_DEMO_COURSES : {};
  const byId = new Map(courses.map(course => [String(course.id), course]));
  const regionCodes = new Set(regions.map(region => region.code));
  /* 기본 제휴 골프장: 시연 재고가 직접 정의된 68곳 (프론트엔드 partner-application.js 와 같은 기준) */
  const baselinePartnerIds = Object.keys(demo).filter(id => demo[id] && demo[id].generatedDemo === false);
  return {
    courses,
    regions,
    demo,
    byId,
    regionCodes,
    baselinePartnerIds,
    defaultPartnerIdSet: new Set(baselinePartnerIds),
    metadata: win.ALL_GOLF_NATIONAL_METADATA || null
  };
}

let cached = null;
function getCatalog() {
  if (!cached) cached = loadCatalog();
  return cached;
}

module.exports = { getCatalog, loadCatalog };
