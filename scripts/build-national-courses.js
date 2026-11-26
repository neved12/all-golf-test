/*
 * ALL:GOLF 전국 골프장 마스터 생성기.
 *
 * 입력(원본은 저작권·용량 때문에 저장소에 커밋하지 않고 data/sources/ 에 로컬 보관)
 *  1) data/sources/kgba-2025-records.json
 *     한국골프장경영협회 2025 가이드북 회원사 현황(기준일 2024-12-08) 구조화 결과.
 *     scripts/import-kgba-courses.js 로 원문 PDF에서 다시 만들 수 있다.
 *  2) data/sources/mcst-national-golf-courses-20241231.zip
 *     문화체육관광부 「전국 골프장 현황」(기준일 2024-12-31) 파일데이터.
 *     https://www.data.go.kr/data/15118920/fileData.do
 *  3) data/sources/localdata-golf-courses-20261126.csv
 *     행정안전부 「생활_골프장」(골프장업 인허가, 내려받은 날 기준 2일 전 현행화).
 *     https://www.data.go.kr/data/15045080/fileData.do
 *     실제 파일: https://file.localdata.go.kr/file/download/golf_courses/info
 *
 * 출력
 *  - data/national-golf-courses.js  (window.ALL_GOLF_NATIONAL_METADATA / ALL_GOLF_NATIONAL_COURSES)
 *  - data/national-build-report.json (생성 통계·제외 목록, 보고서 작성용)
 *
 * 실행: node scripts/build-national-courses.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'sources');
const KGBA_PATH = path.join(SRC, 'kgba-2025-records.json');
const MCST_PATH = path.join(SRC, 'mcst-national-golf-courses-20241231.zip');
const LOCAL_PATH = path.join(SRC, 'localdata-golf-courses-20261126.csv');
const LEGACY_PATH = path.join(SRC, 'legacy-demo-courses.json');
const LEGACY_ENRICH_PATH = path.join(SRC, 'legacy-demo-enrichment.json');
const MAP_PATH = path.join(SRC, 'localdata-course-map.json');
const OUTPUT_PATH = path.join(ROOT, 'data', 'national-golf-courses.js');
const REPORT_PATH = path.join(ROOT, 'data', 'national-build-report.json');

const SOURCE = {
  kgba: {
    url: 'https://www.kgba.co.kr/guidebook/2025/guidebook2025_04.pdf',
    name: '한국골프장경영협회 2025 가이드북 회원사 현황',
    asOf: '2024-12-08'
  },
  mcst: {
    url: 'https://www.data.go.kr/data/15118920/fileData.do',
    name: '문화체육관광부 전국 골프장 현황',
    asOf: '2024-12-31'
  },
  localdata: {
    url: 'https://www.data.go.kr/data/15045080/fileData.do',
    name: '행정안전부 생활_골프장(골프장업 인허가)',
    asOf: '2026-11-24'
  }
};

const REGION_ORDER = ['서울', '경기', '인천', '강원', '충북', '충남', '대전', '세종', '전북', '전남', '광주', '경북', '경남', '대구', '울산', '부산', '제주'];
const GWANGJU_DISTRICTS = new Set(['동구', '서구', '남구', '북구', '광산구']);

/* 시도 접두어 → 지역 코드. 긴 접두어를 먼저 검사한다. */
const REGION_PREFIX = [
  ['서울특별시', '서울'], ['서울시', '서울'], ['서울', '서울'],
  ['부산광역시', '부산'], ['부산시', '부산'], ['부산', '부산'],
  ['대구광역시', '대구'], ['대구시', '대구'], ['대구', '대구'],
  ['인천광역시', '인천'], ['인천시', '인천'], ['인천', '인천'],
  ['전남광주통합특별시', '전남'], ['광주광역시', '광주'], ['광주시', '광주'],
  ['대전광역시', '대전'], ['대전시', '대전'], ['대전', '대전'],
  ['울산광역시', '울산'], ['울산시', '울산'], ['울산', '울산'],
  ['세종특별자치시', '세종'], ['세종시', '세종'], ['세종', '세종'],
  ['경기도', '경기'], ['경기', '경기'],
  ['강원특별자치도', '강원'], ['강원도', '강원'], ['강원', '강원'],
  ['충청북도', '충북'], ['충북', '충북'], ['충청남도', '충남'], ['충남', '충남'],
  ['전북특별자치도', '전북'], ['전라북도', '전북'], ['전북', '전북'],
  ['전라남도', '전남'], ['전남', '전남'],
  ['경상북도', '경북'], ['경북', '경북'], ['경상남도', '경남'], ['경남', '경남'],
  ['제주특별자치도', '제주'], ['제주도', '제주'], ['제주', '제주']
];

const clean = value => String(value == null ? '' : value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const sha1 = value => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 12);

/* ---------------------------------------------------------------- CSV */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(item => item.length > 1 || clean(item[0]));
}

function toObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map(clean);
  return rows.slice(1).map(row => {
    const item = {};
    header.forEach((key, index) => { item[key] = clean(row[index]); });
    return item;
  });
}

/* ZIP 중앙 디렉터리를 읽어 UTF-8 파일명으로 항목을 찾는다(로컬 헤더만으로는 data descriptor 항목의 크기를 알 수 없다). */
function readZipText(zipPath, suffix) {
  const buffer = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let index = buffer.length - 22; index >= 0 && index > buffer.length - 66000; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error(`ZIP 중앙 디렉터리를 찾지 못했습니다: ${zipPath}`);
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 중앙 디렉터리 형식이 올바르지 않습니다.');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name.endsWith(suffix)) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.slice(dataStart, dataStart + compressedSize);
      return method === 0 ? data.toString('utf8') : zlib.inflateRawSync(data).toString('utf8');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP 안에서 ${suffix} 파일을 찾지 못했습니다: ${zipPath}`);
}

/* --------------------------------------------------- 이름·주소 정규화 */

const GENERIC_WORDS = /컨트리클럽|콘트리클럽|카운트클럽|컨츄리클럽|골프앤리조트|골프&리조트|골프리조트|골프클럽|골프장|골프|리조트|씨씨|c\.?\s*c\.?|g\.?\s*c\.?|club/gi;
const OPERATION_WORDS = /회원제|비회원제|비회원|대중제|대중형|대중|정규|일반|임대형/g;

/* 이름에서 법인격·업종 표기·괄호 주석을 걷어내고 비교용 핵심어만 남긴다. */
function coreName(name) {
  let value = String(name || '');
  value = value.replace(/㈜|\(주\)|\(유\)|\(재\)|\(사\)|\(합\)|주식회사|유한회사|재단법인|사단법인/g, '');
  value = value.replace(/\[[^\]]*\]/g, ' ');
  /* 괄호 주석은 중첩될 수 있어 여러 번 벗긴다. */
  for (let pass = 0; pass < 3; pass += 1) value = value.replace(/\([^()]*\)/g, ' ');
  value = value.replace(GENERIC_WORDS, ' ');
  value = value.replace(OPERATION_WORDS, ' ');
  value = value.toLowerCase();
  /* 끝에 붙은 코스 번호(솔라고CC1 · 로얄링스2)는 이름이 아니라 구분 표기다.
     이름이 숫자뿐이면(예: '88골프장') 숫자를 남긴다. */
  const squashed = value.replace(/[^0-9a-z가-힣]/g, '');
  return /^\d+$/.test(squashed) ? squashed : squashed.replace(/\d+$/, '');
}

/* 표시용 이름: 끝에 붙은 운영형태 주석만 걷어낸다. */
function displayName(name) {
  const text = clean(name);
  const stripped = text.replace(/\s*[([[][^)\]]*(회원제|비회원제|비회원|대중제|대중형|대중|정규|일반|임대형)[^)\]]*[)\]]\s*$/u, '').trim();
  return stripped || text;
}

function stripSuffix(token) {
  return String(token || '').replace(/(특별자치시|특별자치도|광역시|특별시|시|군|구|읍|면)$/u, '').trim();
}

/* 폐지·통합된 시군구 이름을 현행 명칭에 맞춘다(비교용). */
const SIGUNGU_ALIAS = { 청원: '청주', 연기: '세종', 여주군: '여주', 마산: '창원', 진해: '창원', 남제주: '서귀포', 북제주: '제주' };
const normalizeCity = value => SIGUNGU_ALIAS[stripSuffix(value)] || stripSuffix(value);

/* 2023년 대구광역시로 편입된 군위, 연기군에서 세종으로 바뀐 지역의 시·도를 현행 명칭에 맞춘다. */
function normalizeRegion(region, city) {
  if (city === '군위') return '대구';
  if (city === '세종') return '세종';
  return region;
}

function cityFromSigungu(value) {
  const first = String(value || '').split(' ')[0];
  const stripped = stripSuffix(first);
  /* '중구'처럼 한 글자로 줄어드는 구 이름은 그대로 둔다. */
  return stripped.length >= 2 ? stripped : first.replace(/(특별자치시|광역시|특별시)$/u, '');
}

/* 주소 → { region, city, roadKey } */
function parseAddress(address) {
  const text = clean(address);
  let region = null;
  let rest = text;
  for (const [prefix, code] of REGION_PREFIX) {
    if (text.startsWith(prefix)) {
      region = code;
      rest = text.slice(prefix.length).trim();
      break;
    }
  }
  const tokens = rest.split(' ').filter(Boolean);
  const firstToken = tokens[0] || '';
  if (region === '전남' && GWANGJU_DISTRICTS.has(firstToken)) region = '광주';
  if (region === '광주' && !GWANGJU_DISTRICTS.has(firstToken) && firstToken) region = '전남';
  const normalized = firstToken ? normalizeCity(firstToken) : '';
  const city = normalized.length >= 2 ? normalized : firstToken;
  return { region: normalizeRegion(region, city), city, roadKey: roadKeyFrom(rest) };
}

function roadKeyFrom(text) {
  /* 도로명 뒤 숫자는 'OO번길/OO번로'일 때만 도로명의 일부다(예: 신평남부길 29-12). */
  const match = String(text || '').replace(/\([^)]*\)/g, ' ')
    .match(/([가-힣A-Za-z0-9]+(?:로|길|대로)(?:\s*\d+번(?:길|로))?)\s*(\d+(?:-\d+)?)/);
  if (!match) return null;
  return `${match[1].replace(/\s+/g, '')}|${match[2]}`;
}

/* 주소에서 읍·면·동 이름을 뽑아 도로명이 달라도 같은 리 단위를 비교한다. */
function dongTokens(text) {
  return new Set((String(text || '').match(/[가-힣]{2,}(?:읍|면|동)/g) || [])
    .filter(token => !/(시|군|구)$/.test(token)));
}

/* ------------------------------------------------------------- 입력 */

function readKgba() {
  if (!fs.existsSync(KGBA_PATH)) throw new Error(`KGBA 구조화 파일이 없습니다: ${KGBA_PATH}`);
  const data = JSON.parse(fs.readFileSync(KGBA_PATH, 'utf8'));
  return data.records.map(record => {
    const parsed = parseAddress(record.address || '');
    const rawCity = record.city || parsed.city;
    /* '서'·'동'처럼 한 글자로 줄어든 시·군·구는 주소의 원래 표기를 쓴다. */
    const city = rawCity && rawCity.length >= 2 ? rawCity : clean(record.address).split(' ')[1] || rawCity;
    return {
      layer: 'kgba',
      id: record.id,
      name: record.name,
      region: normalizeRegion(record.region || parsed.region, city),
      city,
      address: record.address || null,
      operationType: record.operationType || 'unknown',
      holes: Number.isFinite(record.holes) ? record.holes : null,
      memberHoles: Number.isFinite(record.memberHoles) ? record.memberHoles : null,
      publicHoles: Number.isFinite(record.publicHoles) ? record.publicHoles : null,
      phone: record.phone || null,
      officialWebsite: record.officialWebsite || null,
      extraSources: record.sources || [],
      extraSourceName: record.sourceName || null,
      extraSourceAsOf: record.sourceAsOf || null,
      roadKey: parsed.roadKey,
      dong: dongTokens(record.address || '')
    };
  });
}

function readMcst() {
  if (!fs.existsSync(MCST_PATH)) throw new Error(`문체부 원본이 없습니다: ${MCST_PATH}`);
  const text = readZipText(MCST_PATH, '_정비.csv').replace(/^\uFEFF/, '');
  const rows = toObjects(text);
  const facilities = new Map();
  for (const row of rows) {
    const name = clean(row['이름']);
    const address = clean(row['소재지']);
    const sigungu = clean(row['행정구역_시군구명']);
    if (!name || !address) continue;
    const region = clean(row['지역']);
    const city = sigungu ? cityFromSigungu(sigungu) : parseAddress(`${clean(row['행정구역_시도명(현행)'])} ${address}`).city;
    const holes = Number(row['홀']) || null;
    const operationType = row['구분'] === '회원제' ? 'membership' : row['구분'] === '대중제' || row['구분'] === '비회원제' ? 'public' : 'unknown';
    /* 같은 시·군에서 이름이 같은 행은 한 골프장의 코스·운영형태별 등록이다(예: 태광CC 회원제/대중제). */
    const key = `${coreName(name)}|${region}|${city}`;
    if (!facilities.has(key)) {
      facilities.set(key, {
        layer: 'mcst',
        key,
        name: displayName(name),
        rawNames: new Set([name]),
        region,
        city,
        address,
        roadKey: roadKeyFrom(address),
        dong: dongTokens(address),
        operator: clean(row['사업자']),
        holes,
        area: Number(row['면적(제곱미터)']) || null,
        operationTypes: new Set([operationType]),
        rows: 1
      });
    } else {
      const facility = facilities.get(key);
      facility.rawNames.add(name);
      if (address.length > (facility.address || '').length) { facility.address = address; facility.roadKey = roadKeyFrom(address); facility.dong = dongTokens(address); }
      facility.holes = Math.max(facility.holes || 0, holes || 0) || facility.holes;
      facility.area = Math.max(facility.area || 0, Number(row['면적(제곱미터)']) || 0) || facility.area;
      facility.operationTypes.add(operationType);
      facility.rows += 1;
    }
  }
  return [...facilities.values()].map(facility => {
    const types = [...facility.operationTypes].filter(type => type !== 'unknown');
    const operationType = types.length > 1 ? 'mixed' : types[0] || 'unknown';
    return { ...facility, operationTypes: types, operationType, rawNames: [...facility.rawNames] };
  });
}

function readLocal() {
  if (!fs.existsSync(LOCAL_PATH)) throw new Error(`행정안전부 원본이 없습니다: ${LOCAL_PATH}`);
  const text = new TextDecoder('euc-kr').decode(fs.readFileSync(LOCAL_PATH));
  return toObjects(text).map(row => {
    const road = clean(row['도로명주소']);
    const jibun = clean(row['지번주소']);
    const address = road || jibun;
    const parsed = parseAddress(address);
    return {
      layer: 'localdata',
      name: clean(row['사업장명']),
      status: clean(row['영업상태명']),
      detailStatus: clean(row['상세영업상태명']),
      address: address || null,
      jibun: jibun || null,
      roadKey: roadKeyFrom(road),
      dong: new Set([...dongTokens(address), ...dongTokens(jibun)]),
      region: parsed.region,
      city: parsed.city,
      phone: normalizePhone(row['전화번호']),
      licensedAt: clean(row['인허가일자']) || null,
      closedAt: clean(row['폐업일자']) || null,
      orgCode: clean(row['개방자치단체코드']),
      buildingArea: Number(row['건물연면적'] || row['건축물연면적']) || null,
      category: clean(row['문화체육업종명']),
      licenseNo: clean(row['관리번호'])
    };
  }).filter(row => row.name);
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (digits.length === 8) return `(${digits.slice(0, 2)})${digits.slice(2, 5)}-${digits.slice(5)}`;
  if (digits.length === 9) return `(0${digits.slice(0, 2)})${digits.slice(2, 5)}-${digits.slice(5)}`;
  if (digits.length === 10) return /^02/.test(digits) ? `(02)${digits.slice(2, 6)}-${digits.slice(6)}` : `(${digits.slice(0, 3)})${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11) return `(${digits.slice(0, 3)})${digits.slice(3, 7)}-${digits.slice(7)}`;
  return null;
}

/* ----------------------------------------------------------- 매칭 */

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  let previous = new Array(shorter.length + 1).fill(0).map((_, index) => index);
  for (let i = 1; i <= longer.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= shorter.length; j += 1) {
      const cost = longer[i - 1] === shorter[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return 1 - previous[shorter.length] / Math.max(a.length, b.length);
}

const sortedChars = value => String(value || '').split('').sort().join('');

function nameMatch(left, right) {
  const a = left.core;
  const b = right.core;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const min = Math.min(a.length, b.length);
  if (a.replace(/\d/g, '') === b.replace(/\d/g, '')) return 0.98;
  if (min >= 3 && (a.includes(b) || b.includes(a))) return 0.9;
  if (min >= 3 && sortedChars(a) === sortedChars(b)) return 0.85;
  return similarity(a, b);
}

function addressMatch(left, right) {
  if (left.roadKey && right.roadKey && left.roadKey === right.roadKey) return 1;
  const rightDong = right.dong || new Set();
  if ((left.dong ? [...left.dong] : []).some(token => rightDong.has(token))) return 0.8;
  if (left.city && right.city && normalizeCity(left.city) === normalizeCity(right.city)) return 0.45;
  return 0;
}

/* 이름 유사도(60) + 주소 근접도(40)로 짝을 찾는다. 지역(시·도)이 다르면 같은 도로명일 때만 인정한다. */
function scorePair(left, right) {
  if (left.roadKey && right.roadKey && left.roadKey === right.roadKey && left.region === right.region) return 100;
  if (!left.region || !right.region || left.region !== right.region) return 0;
  const name = nameMatch(left, right);
  if (name < 0.8) return 0;
  return Math.round(name * 60 + addressMatch(left, right) * 40);
}

/* 1:1 배정. 점수 높은 순으로 붙이고 이미 짝이 있는 항목은 건너뛴다. */
function assignOneToOne(leftList, rightList, threshold = 70) {
  const pairs = [];
  for (const left of leftList) {
    for (const right of rightList) {
      const score = scorePair(left, right);
      if (score >= threshold) pairs.push({ left, right, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedLeft = new Set();
  const usedRight = new Set();
  const result = new Map();
  for (const pair of pairs) {
    if (usedLeft.has(pair.left) || usedRight.has(pair.right)) continue;
    usedLeft.add(pair.left);
    usedRight.add(pair.right);
    result.set(pair.left, { item: pair.right, score: pair.score });
  }
  return result;
}

/* 여러 행이 한 레코드에 붙을 수 있는 배정(인허가 행 → 마스터). */
function assignManyToOne(rows, targets, threshold = 70) {
  const result = new Map();
  for (const row of rows) {
    let best = null;
    for (const target of targets) {
      const score = scorePair(row, target);
      if (score >= threshold && (!best || score > best.score)) best = { item: target, score };
    }
    if (best) result.set(row, best);
  }
  return result;
}

const withCore = (item, name) => ({ ...item, core: coreName(name || item.name) });

/* ------------------------------------------------------- 레코드 생성 */

function verificationOf(record) {
  return {
    name: Boolean(record.name),
    region: Boolean(record.region),
    city: Boolean(record.city),
    address: Boolean(record.address),
    operationType: Boolean(record.operationType && record.operationType !== 'unknown'),
    holes: Number.isFinite(record.holes),
    phone: Boolean(record.phone),
    website: Boolean(record.officialWebsite)
  };
}

function buildRecord(seed) {
  const record = {
    id: seed.id,
    name: seed.name,
    region: seed.region,
    city: seed.city,
    address: seed.address || null,
    operationType: seed.operationType || 'unknown',
    holes: Number.isFinite(seed.holes) ? seed.holes : null,
    memberHoles: Number.isFinite(seed.memberHoles) ? seed.memberHoles : null,
    publicHoles: Number.isFinite(seed.publicHoles) ? seed.publicHoles : null,
    phone: seed.phone || null,
    operatingStatus: seed.operatingStatus || 'active',
    verified: false,
    verification: null,
    officialWebsite: seed.officialWebsite || null,
    officialBookingUrl: null,
    courses: [],
    latitude: null,
    longitude: null,
    partner: false,
    bookingStatus: 'info',
    bookingType: null,
    dataMode: 'official_info',
    source: seed.source,
    sources: seed.sources,
    sourceName: seed.sourceName,
    sourceAsOf: seed.sourceAsOf,
    lastVerified: seed.lastVerified,
    licenseCount: seed.licenseCount || 0,
    licensedName: seed.licensedName || null,
    demoCatalog: Boolean(seed.demoCatalog)
  };
  record.verification = verificationOf(record);
  record.verified = Object.values(record.verification).every(Boolean);
  return record;
}

/* ------------------------------------------------------------ main */

function readLegacy() {
  if (!fs.existsSync(LEGACY_PATH)) throw new Error(`시연 예약 골프장 명부가 없습니다: ${LEGACY_PATH}`);
  const data = JSON.parse(fs.readFileSync(LEGACY_PATH, 'utf8'));
  /* 공식 출처에 값이 없던 시연 골프장은 별도 확인 자료로 보완한다. */
  const enrich = fs.existsSync(LEGACY_ENRICH_PATH) ? JSON.parse(fs.readFileSync(LEGACY_ENRICH_PATH, 'utf8')).records || [] : [];
  const enrichById = new Map(enrich.map(item => [item.id, item]));
  return data.records.map(raw => {
    const record = { ...raw, ...(enrichById.get(raw.id) || {}) };
    const parsed = parseAddress(record.address || '');
    return {
      layer: 'legacy',
      id: record.id,
      name: record.name,
      region: record.region || parsed.region,
      city: record.city || parsed.city,
      address: record.address || null,
      operationType: record.operationType || 'unknown',
      holes: Number.isFinite(record.holes) ? record.holes : null,
      memberHoles: Number.isFinite(record.memberHoles) ? record.memberHoles : null,
      publicHoles: Number.isFinite(record.publicHoles) ? record.publicHoles : null,
      phone: record.phone || null,
      officialWebsite: record.officialWebsite || null,
      extraSources: record.sources || [],
      extraSourceName: record.sourceName || null,
      extraSourceAsOf: record.sourceAsOf || null,
      roadKey: parsed.roadKey,
      dong: dongTokens(record.address || '')
    };
  });
}

function readMapRules() {
  if (!fs.existsSync(MAP_PATH)) return [];
  const data = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  return Array.isArray(data.rules) ? data.rules : [];
}

function main() {
  const kgba = readKgba().map(item => withCore(item));
  const mcst = readMcst().map(item => withCore(item));
  const legacy = readLegacy().map(item => withCore(item));
  const mapRules = readMapRules();
  const localAll = readLocal();
  const localActive = localAll.map(item => withCore(item)).filter(row => row.status === '영업/정상');
  const localClosed = localAll.map(item => withCore(item)).filter(row => row.status !== '영업/정상');

  /* 1) 명부끼리 맞추기: 시연 예약 68곳 ↔ 협회 명부 ↔ 문체부 등록 현황 */
  const legacyToKgba = assignOneToOne(legacy, kgba);
  const usedKgba = new Set([...legacyToKgba.values()].map(match => match.item));
  const kgbaFree = kgba.filter(item => !usedKgba.has(item));
  const legacyOnly = legacy.filter(item => !legacyToKgba.has(item));
  const kgbaToMcst = assignOneToOne([...kgba, ...legacyOnly], mcst);
  const usedMcst = new Set([...kgbaToMcst.values()].map(match => match.item));

  const masters = [];
  const masterForKgba = new Map();
  for (const item of legacy) {
    const kgbaItem = legacyToKgba.get(item)?.item || null;
    const mcstItem = (kgbaItem ? kgbaToMcst.get(kgbaItem)?.item : kgbaToMcst.get(item)?.item) || null;
    const master = {
      id: item.id,
      name: item.name,
      region: item.region || kgbaItem?.region || mcstItem?.region || null,
      city: item.city || kgbaItem?.city || mcstItem?.city || null,
      address: item.address || kgbaItem?.address || mcstItem?.address || null,
      roadKey: item.roadKey || mcstItem?.roadKey || null,
      dong: item.dong,
      operationType: firstKnown(item.operationType, kgbaItem?.operationType, mcstItem?.operationType),
      holes: item.holes || kgbaItem?.holes || mcstItem?.holes || null,
      memberHoles: item.memberHoles ?? kgbaItem?.memberHoles ?? null,
      publicHoles: item.publicHoles ?? kgbaItem?.publicHoles ?? null,
      phone: item.phone || kgbaItem?.phone || null,
      officialWebsite: item.officialWebsite || null,
      extraSources: item.extraSources || [],
      extraSourceName: item.extraSourceName || null,
      extraSourceAsOf: item.extraSourceAsOf || null,
      legacy: item,
      kgba: kgbaItem,
      mcst: mcstItem
    };
    if (kgbaItem) masterForKgba.set(kgbaItem, master);
    masters.push(master);
  }
  for (const item of kgbaFree) {
    const mcstItem = kgbaToMcst.get(item)?.item || null;
    const master = {
      id: item.id,
      name: item.name,
      region: item.region || mcstItem?.region || null,
      city: item.city || mcstItem?.city || null,
      address: item.address || mcstItem?.address || null,
      roadKey: item.roadKey || mcstItem?.roadKey || null,
      dong: item.dong,
      operationType: firstKnown(item.operationType, mcstItem?.operationType),
      holes: item.holes || mcstItem?.holes || null,
      memberHoles: item.memberHoles ?? null,
      publicHoles: item.publicHoles ?? null,
      phone: item.phone || null,
      legacy: null,
      kgba: item,
      mcst: mcstItem
    };
    masterForKgba.set(item, master);
    masters.push(master);
  }
  for (const facility of mcst) {
    if (usedMcst.has(facility)) continue;
    masters.push({
      id: `mcst-${sha1(`${facility.name}|${facility.address}`)}`,
      name: facility.name,
      region: facility.region,
      city: facility.city,
      address: facility.address,
      roadKey: facility.roadKey,
      dong: facility.dong,
      operationType: facility.operationType,
      holes: facility.holes,
      memberHoles: facility.operationType === 'membership' ? facility.holes : facility.operationType === 'public' ? 0 : null,
      publicHoles: facility.operationType === 'public' ? facility.holes : facility.operationType === 'membership' ? 0 : null,
      phone: null,
      legacy: null,
      kgba: null,
      mcst: facility
    });
  }

  const mastersWithCore = masters.map(master => ({ ...master, core: coreName(master.name) }));

  /* 2) 인허가 행 → 명부 레코드(여러 행이 한 골프장에 붙을 수 있다) */
  const localToMaster = assignManyToOne(localActive, mastersWithCore);
  const licenseByMaster = new Map(mastersWithCore.map(master => [master, []]));
  for (const [row, match] of localToMaster) licenseByMaster.get(match.item).push(row);

  /* 3) 자동 매칭에서 남은 인허가 행 정리(중복·부속시설·신규) */
  const leftovers = localActive.filter(row => !localToMaster.has(row));
  const ruleFor = row => mapRules.find(rule => clean(rule.name) === clean(row.name) && (!rule.addressContains || String(row.address || '').includes(rule.addressContains)));
  const excludedLicenses = [];
  const mergeNotes = [];
  const pending = [];
  for (const row of leftovers) {
    const rule = ruleFor(row);
    if (rule && rule.action === 'exclude') excludedLicenses.push({ name: row.name, address: row.address, status: row.detailStatus, reason: rule.reason });
    else pending.push({ row, rule });
  }
  const stillPending = [];
  for (const { row, rule } of pending) {
    if (rule && rule.action === 'merge') {
      const targetCore = coreName(rule.target);
      const target = !targetCore || targetCore.length < 2 ? null : mastersWithCore.find(master => master.core === targetCore)
        || (targetCore && targetCore.length >= 2 ? mastersWithCore.find(master => master.core.length >= 2 && (master.core.includes(targetCore) || targetCore.includes(master.core))) : null);
      if (target) {
        licenseByMaster.get(target).push(row);
        mergeNotes.push({ name: row.name, target: target.name, reason: rule.reason });
        continue;
      }
    }
    stillPending.push({ row, rule });
  }
  /* 남은 행끼리 같은 골프장인 경우(예: 성주 헤븐랜드 → 롯데스카이힐성주) 한 레코드로 합친다. */
  const pendingByCore = new Map();
  for (const entry of stillPending) if (!pendingByCore.has(entry.row.core)) pendingByCore.set(entry.row.core, entry);
  const absorbedInto = new Map();
  const stillPending2 = [];
  for (const entry of stillPending) {
    const rule = entry.rule;
    const targetCore = rule && rule.action === 'merge' ? coreName(rule.target) : '';
    const targetEntry = targetCore && targetCore.length >= 2 ? pendingByCore.get(targetCore) : null;
    if (targetEntry && targetEntry !== entry) {
      if (!absorbedInto.has(targetEntry.row)) absorbedInto.set(targetEntry.row, []);
      absorbedInto.get(targetEntry.row).push(entry.row);
      mergeNotes.push({ name: entry.row.name, target: targetEntry.row.name, reason: rule.reason });
      continue;
    }
    stillPending2.push(entry);
  }
  const pendingGroups = new Map();
  for (const entry of stillPending2) {
    const key = `${entry.row.core}|${entry.row.region}|${entry.row.city}`;
    if (!pendingGroups.has(key)) pendingGroups.set(key, []);
    pendingGroups.get(key).push(entry);
  }
  const leftoverCandidates = [];
  const leftoverExcluded = [];
  for (const group of pendingGroups.values()) {
    const head = group[0];
    const aliases = group.slice(1).map(entry => entry.row);
    /* 그룹 안 어느 라이선스에든 정리 규칙이 있으면 그 규칙을 따른다. */
    const rule = group.map(entry => entry.rule).find(Boolean) || null;
    const merged = aliases.reduce((acc, row) => { acc.push(row); return acc; }, [head.row, ...(absorbedInto.get(head.row) || [])]);
    if (rule && rule.action === 'exclude') leftoverExcluded.push({ name: head.row.name, address: head.row.address, reason: rule.reason });
    else if ((rule && rule.action === 'include') || isCourseGolfFacility(head.row)) leftoverCandidates.push({ head: head.row, licenses: merged, rule });
    else leftoverExcluded.push({ name: head.row.name, address: head.row.address, reason: '코스 골프장 명칭·시설로 확인되지 않음(연습장·부속시설)' });
  }

  /* 4) 영업 중 인허가가 없는 명부 레코드 중 폐업·휴업으로 확인되는 곳 제외 */
  const closedMaster = [];
  for (const master of mastersWithCore) {
    if (licenseByMaster.get(master).length) continue;
    const closed = localClosed.filter(row => scorePair(row, master) >= 70);
    if (closed.length) {
      closedMaster.push({ name: master.name, region: master.region, city: master.city, licenses: closed.map(row => ({ name: row.name, status: row.detailStatus || row.status, closedAt: row.closedAt })) });
      master.closed = true;
    }
  }

  const records = [];
  const usedIds = new Set();
  const uniqueId = base => {
    let id = base;
    let index = 2;
    while (usedIds.has(id)) { id = `${base}-${index}`; index += 1; }
    usedIds.add(id);
    return id;
  };

  for (const master of mastersWithCore) {
    if (master.closed) continue;
    const licenses = licenseByMaster.get(master);
    const license = licenses[0] || null;
    const sources = [];
    const names = [];
    if (master.legacy) { sources.push(SOURCE.kgba.url); names.push(SOURCE.kgba.name); }
    if (master.kgba) { sources.push(SOURCE.kgba.url); names.push(SOURCE.kgba.name); }
    if (master.mcst) { sources.push(SOURCE.mcst.url); names.push(SOURCE.mcst.name); }
    if (licenses.length) { sources.push(SOURCE.localdata.url); names.push(SOURCE.localdata.name); }
    for (const extra of master.extraSources || []) sources.push(extra);
    if (master.extraSourceName) names.push(master.extraSourceName);
    const uniqueNames = [...new Set(names)];
    records.push(buildRecord({
      id: uniqueId(master.id),
      name: master.name,
      region: master.region || (license ? license.region : null),
      city: master.city || (license ? license.city : null),
      address: master.address || (license ? license.address : null),
      operationType: master.operationType,
      holes: master.holes,
      memberHoles: master.memberHoles,
      publicHoles: master.publicHoles,
      phone: master.phone || (license ? license.phone : null),
      officialWebsite: master.officialWebsite || null,
      operatingStatus: 'active',
      source: master.kgba || master.legacy ? SOURCE.kgba.url : SOURCE.mcst.url,
      sources: [...new Set(sources)],
      sourceName: uniqueNames.join(' · '),
      sourceAsOf: master.mcst ? SOURCE.mcst.asOf : SOURCE.kgba.asOf,
      lastVerified: master.extraSourceAsOf || (licenses.length ? SOURCE.localdata.asOf : master.mcst ? SOURCE.mcst.asOf : SOURCE.kgba.asOf),
      licenseCount: licenses.length,
      licensedName: license ? license.name : null,
      demoCatalog: Boolean(master.legacy)
    }));
  }

  for (const candidate of leftoverCandidates) {
    const head = candidate.head;
    records.push(buildRecord({
      id: uniqueId(`lcs-${sha1(`${head.name}|${head.address}`)}`),
      name: displayName(head.name),
      region: head.region,
      city: head.city,
      address: head.address,
      operationType: 'unknown',
      holes: null,
      phone: head.phone,
      operatingStatus: 'active',
      source: SOURCE.localdata.url,
      sources: [SOURCE.localdata.url],
      sourceName: `${SOURCE.localdata.name}(명부 미등재 신규·누락)`,
      sourceAsOf: SOURCE.localdata.asOf,
      lastVerified: SOURCE.localdata.asOf,
      licenseCount: candidate.licenses.length,
      licensedName: candidate.licenses.map(row => row.name).join(' / ')
    }));
  }

  const sorted = sortRecords(records);
  const stats = {
    input: { legacyDemo: legacy.length, kgba: kgba.length, mcstFacilities: mcst.length, localTotal: localAll.length, localActive: localActive.length, localClosed: localClosed.length },
    matched: {
      legacyToKgba: legacyToKgba.size,
      kgbaToMcst: kgbaToMcst.size,
      localRowsToMaster: localToMaster.size,
      mastersWithLicense: mastersWithCore.filter(master => licenseByMaster.get(master).length).length
    },
    manualMerges: [...new Map(mergeNotes.map(note => [`${note.name}|${note.target}`, note])).values()],
    excludedLicenses,
    excludedClosed: closedMaster,
    leftoverCandidates: leftoverCandidates.map(candidate => ({ name: candidate.head.name, region: candidate.head.region, city: candidate.head.city, address: candidate.head.address })),
    leftoverExcluded,
    total: sorted.length,
    demoCount: sorted.filter(record => record.demoCatalog).length,
    regionCounts: sorted.reduce((acc, record) => { acc[record.region] = (acc[record.region] || 0) + 1; return acc; }, {}),
    operationCounts: sorted.reduce((acc, record) => { acc[record.operationType] = (acc[record.operationType] || 0) + 1; return acc; }, {}),
    missing: {
      address: sorted.filter(record => !record.address).length,
      holes: sorted.filter(record => !record.holes).length,
      phone: sorted.filter(record => !record.phone).length,
      operationType: sorted.filter(record => record.operationType === 'unknown').length
    }
  };

  const metadata = {
    source: SOURCE.mcst.url,
    sourceName: '문화체육관광부 전국 골프장 현황 + 행정안전부 생활_골프장 + 한국골프장경영협회 회원사 명부',
    sourceAsOf: SOURCE.mcst.asOf,
    generatedAt: new Date().toISOString(),
    count: sorted.length,
    sources: [SOURCE.mcst, SOURCE.localdata, SOURCE.kgba]
  };

  const header = '// 자동 생성 파일. 직접 수정하지 말고 scripts/build-national-courses.js를 실행하세요.\n';
  fs.writeFileSync(OUTPUT_PATH, `${header}window.ALL_GOLF_NATIONAL_METADATA=${JSON.stringify(metadata, null, 2)};\nwindow.ALL_GOLF_NATIONAL_COURSES=${JSON.stringify(sorted, null, 2)};\n`, 'utf8');
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(stats, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    output: OUTPUT_PATH,
    total: sorted.length,
    demoCount: stats.demoCount,
    regionCounts: stats.regionCounts,
    matched: stats.matched,
    manualMerges: stats.manualMerges.length,
    excludedLicenses: stats.excludedLicenses.length,
    excludedClosed: stats.excludedClosed.length,
    leftoverCandidates: stats.leftoverCandidates.length,
    leftoverExcluded: stats.leftoverExcluded.length,
    missing: stats.missing
  }, null, 2));
}

function firstKnown(...values) {
  return values.find(value => value && value !== 'unknown') || 'unknown';
}

const NON_COURSE = /연습장|스크린|실내|당구|파3|파 3|간이|어프로치|숏게임|스튜디오|시뮬레|인도어|루프탑|캠핑|숙박|호텔|콘도|부동산|건설/i;
const COURSE_NAME = /골프장|골프클럽|컨트리클럽|콘트리클럽|카운트클럽|골프앤리조트|골프&리조트|골프리조트|c\.?c|gc|club|리조트|골프/i;

function isCourseGolfFacility(row) {
  const name = clean(row.name);
  if (!COURSE_NAME.test(name)) return false;
  if (NON_COURSE.test(name)) return false;
  if (/상가|지하|오피스|빌딩/.test(row.jibun || '')) return false;
  return true;
}

function sortRecords(records) {
  const regionIndex = value => {
    const index = REGION_ORDER.indexOf(value);
    return index === -1 ? REGION_ORDER.length : index;
  };
  return records.slice().sort((a, b) =>
    regionIndex(a.region) - regionIndex(b.region) ||
    String(a.city || '').localeCompare(String(b.city || ''), 'ko') ||
    String(a.name || '').localeCompare(String(b.name || ''), 'ko'));
}

main();
