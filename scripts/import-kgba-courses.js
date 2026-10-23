/*
 * 한국골프장경영협회 2025 가이드북의 회원사 명부를 정적 JS 데이터로 변환한다.
 * 원본 기준일: 2024-12-08 / 원본 URL은 SOURCE_URL 참조.
 * 실행 예:
 *   NODE_PATH=<codex node_modules> node scripts/import-kgba-courses.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PDF_PATH = path.join(ROOT, 'data', 'sources', 'kgba-2025-member-courses.pdf');
const OUTPUT_PATH = path.join(ROOT, 'data', 'national-golf-courses.js');
const SOURCE_URL = 'https://www.kgba.co.kr/guidebook/2025/guidebook2025_04.pdf';
const SOURCE_DATE = '2024-12-08';

const REGION_MAP = [
  ['서울특별시', '서울'], ['경기도', '경기'], ['인천광역시', '인천'],
  ['강원특별자치도', '강원'], ['강원도', '강원'], ['충청북도', '충북'], ['충북', '충북'],
  ['충청남도', '충남'], ['충남', '충남'], ['대전광역시', '대전'],
  ['세종특별자치시', '세종'], ['전북특별자치도', '전북'], ['전북', '전북'],
  ['전라남도', '전남'], ['전남', '전남'], ['광주광역시', '광주'],
  ['경상북도', '경북'], ['경북', '경북'], ['경상남도', '경남'], ['경남', '경남'],
  ['대구광역시', '대구'], ['울산광역시', '울산'], ['부산광역시', '부산'],
  ['제주특별자치도', '제주']
];

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const stableId = (name, address) => `kgba-${crypto.createHash('sha1').update(`${name}|${address}`).digest('hex').slice(0, 12)}`;

function splitRegion(address) {
  const found = REGION_MAP.find(([prefix]) => address.startsWith(prefix));
  if (!found) return { region: '미확인', city: '미확인' };
  const rest = clean(address.slice(found[0].length));
  const first = rest.split(' ')[0] || '미확인';
  const city = found[1] === '세종' ? '세종시' : first.replace(/(시|군|구)$/, '');
  return { region: found[1], city };
}

function parseSide(items, side) {
  const isLeft = side === 'left';
  const groups = new Map();
  for (const item of items) {
    const x = item.transform[4], y = Math.round(item.transform[5]);
    const inSide = isLeft ? x >= 60 && x < 600 : x >= 665 && x < 1130;
    if (!inSide || y < 100 || y > 610) continue;
    if (!groups.has(y)) groups.set(y, []);
    groups.get(y).push({ x, text: clean(item.str) });
  }

  const boundaries = isLeft
    ? { name: [60, 160], member: [160, 203], public: [203, 245], address: [245, 420], phone: [420, 600] }
    : { name: [665, 765], member: [765, 807], public: [807, 850], address: [850, 1020], phone: [1020, 1130] };
  const within = (x, range) => x >= range[0] && x < range[1];
  const join = (row, range) => clean(row.filter(v => within(v.x, range)).sort((a, b) => a.x - b.x).map(v => v.text).join(' '));

  return [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([, row]) => {
    const name = join(row, boundaries.name);
    const memberHoles = Number(join(row, boundaries.member)) || 0;
    const publicHoles = Number(join(row, boundaries.public)) || 0;
    const address = join(row, boundaries.address);
    const phone = join(row, boundaries.phone);
    if (!name || !address || (!memberHoles && !publicHoles)) return null;
    const operationType = memberHoles && publicHoles ? 'mixed' : memberHoles ? 'membership' : 'public';
    const { region, city } = splitRegion(address);
    return {
      id: stableId(name, address), name, region, city, address,
      operationType, holes: memberHoles + publicHoles, memberHoles, publicHoles,
      phone: phone || null, operatingStatus: 'active', verified: true,
      verification: { name: true, region: region !== '미확인', city: city !== '미확인', address: true, operationType: true, holes: true, phone: Boolean(phone), website: false },
      officialWebsite: null, officialBookingUrl: null, courses: [], latitude: null, longitude: null,
      partner: false, bookingStatus: 'info', bookingType: null, dataMode: 'official_info',
      source: SOURCE_URL, sources: [SOURCE_URL], sourceName: '한국골프장경영협회 2025 가이드북 회원사 현황',
      sourceAsOf: SOURCE_DATE, lastVerified: SOURCE_DATE
    };
  }).filter(Boolean);
}

async function main() {
  if (!process.env.NODE_PATH) throw new Error('NODE_PATH에 pdfjs-dist가 포함된 node_modules 경로가 필요합니다.');
  const pdfModule = pathToFileURL(path.join(process.env.NODE_PATH, 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href;
  const pdfjs = await import(pdfModule);
  const document = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(PDF_PATH)) }).promise;
  const rows = [];
  for (let pageNumber = 2; pageNumber <= Math.min(4, document.numPages); pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    rows.push(...parseSide(content.items, 'left'), ...parseSide(content.items, 'right'));
  }
  const bySignature = new Map();
  for (const row of rows) bySignature.set(`${row.name}|${row.address}`, row);
  const courses = [...bySignature.values()].sort((a, b) => a.region.localeCompare(b.region, 'ko') || a.city.localeCompare(b.city, 'ko') || a.name.localeCompare(b.name, 'ko'));
  const header = `// 자동 생성 파일. 직접 수정하지 말고 scripts/import-kgba-courses.js를 실행하세요.\n`;
  const metadata = { source: SOURCE_URL, sourceName: '한국골프장경영협회 2025 가이드북 회원사 현황', sourceAsOf: SOURCE_DATE, generatedAt: new Date().toISOString(), count: courses.length };
  fs.writeFileSync(OUTPUT_PATH, `${header}window.ALL_GOLF_NATIONAL_METADATA=${JSON.stringify(metadata, null, 2)};\nwindow.ALL_GOLF_NATIONAL_COURSES=${JSON.stringify(courses, null, 2)};\n`, 'utf8');
  console.log(JSON.stringify({ output: OUTPUT_PATH, count: courses.length, regions: Object.fromEntries(Object.entries(courses.reduce((acc, c) => { acc[c.region] = (acc[c.region] || 0) + 1; return acc; }, {})).sort()) }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
