/* ALL:GOLF 골프장 제휴 신청·승인 저장소 (5단계)
   - partner/ 에서 접수한 제휴 신청을 localStorage에 보관하고 접수번호로 상태를 조회한다.
   - 본사 관리자가 승인하면 해당 골프장이 사용자 앱의 예약 가능(제휴) 골프장으로 반영된다.
   - 시연용 저장소이며 실제 계약·정산·본인 인증과 연결되어 있지 않다.
   - 기존 골프장 68곳(시연 예약 데이터가 직접 부여된 골프장)은 기본 제휴 골프장으로 본다. */
(function () {
  'use strict';

  const KEY = 'allGolfPartnerApplicationsV1';
  const PARTNERSHIP_KEY = 'allGolfPartnershipStatusV1';
  const STATUS_LABELS = { pending: '검토 대기', approved: '승인 완료', rejected: '반려' };
  const MODE_LABELS = { existing: '기존 골프장', new: '신규 골프장' };
  const MAX_MEMO = 500;
  const SLOT_TIMES = ['06:52', '07:38', '08:24', '12:41', '13:27'];

  const masterCourses = () => (Array.isArray(window.ALL_GOLF_COURSES) ? window.ALL_GOLF_COURSES : []);
  const demoCatalog = () => window.ALL_GOLF_DEMO_COURSES || {};
  const regionCodes = () => (window.ALL_GOLF_REGIONS || []).map(item => item.code).filter(code => code && code !== '전체');
  const text = value => String(value ?? '').trim().replace(/\s+/g, ' ');
  const digits = value => String(value ?? '').replace(/\D/g, '');
  const isPhone = value => /^01[016789]\d{7,8}$/.test(digits(value));
  const isEmail = value => /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(text(value));
  const normalizeName = value => String(value ?? '')
    .toLocaleLowerCase('ko')
    .replace(/(컨트리클럽|골프클럽|골프앤리조트|골프&리조트|리조트|cc|gc|club|플라자)/gi, '')
    .replace(/[^0-9a-z가-힣]/g, '');
  const moneyValue = value => {
    if (value === '' || value == null) return null;
    const number = Number(String(value).replace(/[,\s원]/g, ''));
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : NaN;
  };
  const pad = value => String(value).padStart(2, '0');
  const dayKey = date => `${String(date.getFullYear()).slice(2)}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;

  const read = () => {
    try {
      const list = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(list) ? list.filter(item => item && typeof item === 'object' && item.id) : [];
    } catch { return []; }
  };
  const write = list => {
    localStorage.setItem(KEY, JSON.stringify(list));
    if (typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('allgolf:partnerschange'));
    }
    return list;
  };

  /* 기본 제휴 골프장: demo-teetimes.js 에서 직접 정의한 68곳(generatedDemo=false) */
  const DEFAULT_PARTNER_IDS = Object.keys(demoCatalog()).filter(id => demoCatalog()[id] && demoCatalog()[id].generatedDemo === false);
  const defaultPartnerIds = () => DEFAULT_PARTNER_IDS.slice();

  /* 6단계: 서버 연동 모드에서 승인된 골프장도 같은 기준으로 포함한다. */
  const serverSync = () => (window.ALL_GOLF_PARTNER_SYNC && typeof window.ALL_GOLF_PARTNER_SYNC.approvedIds === 'function' ? window.ALL_GOLF_PARTNER_SYNC : null);
  const partnerIds = () => {
    const ids = new Set(DEFAULT_PARTNER_IDS);
    read().forEach(app => {
      if (app.status !== 'approved') return;
      if (app.courseMode === 'new' && app.newCourseId) ids.add(app.newCourseId);
      else if (app.courseId) ids.add(app.courseId);
    });
    const sync = serverSync();
    if (sync) sync.approvedIds().forEach(id => ids.add(String(id)));
    return ids;
  };
  const isPartnerCourse = id => partnerIds().has(String(id || ''));
  const partneredCourseCount = () => partnerIds().size;

  const courseIdOf = app => (app.courseMode === 'new' ? app.newCourseId : app.courseId) || '';

  const baseGreenFee = app => {
    const configured = Number(app?.conditions?.weekdayGreenFee);
    return Number.isFinite(configured) && configured > 0 ? Math.round(configured) : 150000;
  };

  const demoObject = app => {
    const base = baseGreenFee(app);
    return {
      dataMode: 'demo', generatedDemo: true, partnerDemo: true,
      demoGreenFee: base,
      demoTeeTimes: SLOT_TIMES.map((time, index) => ({ time, price: base + (index === 2 ? 10000 : index === 4 ? -5000 : 0), remaining: 1 + (index % 3), special: false })),
      demoCartFee: Number(app?.conditions?.cartFee) > 0 ? Number(app.conditions.cartFee) : 100000,
      demoCaddieFee: Number(app?.conditions?.caddieFee) > 0 ? Number(app.conditions.caddieFee) : 150000,
      demoDeposit: Number(app?.conditions?.deposit) > 0 ? Number(app.conditions.deposit) : 30000,
      demoNoCaddie: false, demoDeal: false, demoThreePlayerSurcharge: 10000,
      demoNotice: '시연용 예약이며 실제 골프장 예약이 아닙니다'
    };
  };

  /* 승인된 신규 골프장을 사용자 앱의 마스터/시연 데이터로 변환한다.
     서버에서 승인된 신규 골프장(6단계)은 partner-sync 캐시에서 합친다. */
  const approvedCourses = () => {
    const local = read()
      .filter(app => app.status === 'approved' && app.courseMode === 'new' && app.newCourseId && app.course)
      .map(app => {
        const data = app.course || {};
        const approvedAt = app.decision?.at || app.updatedAt || app.createdAt || null;
        return {
          course: {
            id: app.newCourseId,
            name: text(data.name),
            region: text(data.region),
            city: text(data.city),
            area: text(data.city),
            address: text(data.address) || null,
            operationType: ['public', 'membership', 'mixed'].includes(data.operationType) ? data.operationType : 'public',
            type: ['public', 'membership', 'mixed'].includes(data.operationType) ? data.operationType : 'public',
            membershipType: null,
            holes: Number(data.holes) || null,
            courses: [],
            phone: text(data.phone) || null,
            officialWebsite: text(data.website) || null,
            officialBookingUrl: null,
            website: text(data.website) || null,
            operatingStatus: 'active',
            verified: false,
            verification: {},
            sources: [],
            source: null,
            sourceName: 'ALL:GOLF 제휴 신청 승인',
            sourceAsOf: approvedAt ? String(approvedAt).slice(0, 10) : null,
            lastVerified: approvedAt ? String(approvedAt).slice(0, 10) : null,
            lastUpdated: approvedAt ? String(approvedAt).slice(0, 7) : null,
            greenFee: null,
            verifiedGreenFee: null,
            cartFee: null,
            caddieFee: null,
            bookingType: 'demo',
            bookingStatus: 'demo',
            partner: true,
            partnered: true,
            latitude: null,
            longitude: null,
            description: '골프장 제휴 신청 승인으로 등록된 시연용 골프장입니다.',
            amenities: [],
            cancellationPolicy: null,
            dataMode: 'demo',
            partnerApplicationId: app.id
          },
          demo: demoObject(app)
        };
      });
    const sync = serverSync();
    const remote = sync ? sync.entries() : [];
    const seen = new Set(local.map(entry => entry.course.id));
    return [...local, ...remote.filter(entry => entry && entry.course && !seen.has(entry.course.id))];
  };

  const demoTimesFor = (courseId, date) => {
    const app = read().find(item => item.status === 'approved' && item.newCourseId === courseId);
    const sync = serverSync();
    if (!app && sync) {
      const remote = sync.timesFor(courseId, date);
      if (remote) return remote;
    }
    if (!app) return [];
    const seed = [...String(courseId)].reduce((sum, char) => sum + char.charCodeAt(0), 0)
      + [...String(date || '')].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const weekend = [0, 6].includes(new Date(`${date}T00:00:00`).getDay());
    const base = baseGreenFee(app) + (weekend ? 20000 : 0);
    return SLOT_TIMES.map((time, index) => ({
      time,
      price: base + (index === 2 ? 10000 : index === 4 ? -5000 : 0),
      remaining: 1 + ((seed + index) % 3),
      special: false,
      dataMode: 'demo'
    }));
  };

  const receiptId = list => {
    const day = dayKey(new Date());
    const used = new Set(list.map(item => String(item.id)));
    let sequence = list.filter(item => String(item.id).slice(3, 9) === day).length + 1;
    let candidate = `PA-${day}-${String(sequence).padStart(4, '0')}`;
    while (used.has(candidate)) {
      sequence += 1;
      candidate = `PA-${day}-${String(sequence).padStart(4, '0')}`;
    }
    return candidate;
  };

  const newCourseId = list => {
    const used = new Set([...list.map(item => String(item.newCourseId || '')), ...masterCourses().map(item => String(item.id))]);
    let index = list.length + 1;
    let candidate = `ap-${Date.now().toString(36)}${index}`;
    while (used.has(candidate)) {
      index += 1;
      candidate = `ap-${Date.now().toString(36)}${index}`;
    }
    return candidate;
  };

  const pendingFor = (list, match) => list.find(item => item.status === 'pending' && match(item));
  const approvedFor = (list, match) => list.find(item => item.status === 'approved' && match(item));

  /* 신청 검증 + 접수 */
  const validate = (input, list) => {
    const errors = {};
    const mode = input?.courseMode === 'new' ? 'new' : 'existing';
    let courseId = '';
    let course = { name: '', region: '', city: '', address: '', phone: '', website: '', holes: '', operationType: 'public' };
    if (mode === 'existing') {
      const selected = masterCourses().find(item => item.id === text(input?.courseId));
      if (!selected) errors.courseId = '제휴를 신청할 골프장을 선택해주세요.';
      else {
        courseId = selected.id;
        course = {
          name: selected.name, region: selected.region, city: selected.city,
          address: selected.address || '', phone: selected.phone || '',
          website: selected.officialWebsite || selected.website || '',
          holes: selected.holes || '', operationType: selected.operationType || 'public'
        };
        if (isPartnerCourse(selected.id)) errors.courseId = '이미 ALL:GOLF 제휴 중인 골프장입니다.';
        const pending = pendingFor(list, item => item.courseMode === 'existing' && item.courseId === selected.id);
        if (pending) errors.courseId = `이미 검토 중인 신청이 있습니다. (접수번호 ${pending.id})`;
      }
    } else {
      course.name = text(input?.courseName);
      course.region = text(input?.region);
      course.city = text(input?.city);
      course.address = text(input?.address);
      course.phone = text(input?.coursePhone);
      course.website = text(input?.website);
      course.holes = text(input?.holes);
      course.operationType = ['public', 'membership', 'mixed'].includes(input?.operationType) ? input.operationType : 'public';
      if (course.name.length < 2 || course.name.length > 40) errors.courseName = '골프장명을 2~40자로 입력해주세요.';
      if (!regionCodes().includes(course.region)) errors.region = '지역을 선택해주세요.';
      if (!course.city || course.city.length > 20) errors.city = '시·군을 20자 이하로 입력해주세요.';
      if (course.holes && (!Number.isInteger(Number(course.holes)) || Number(course.holes) < 9 || Number(course.holes) > 72)) errors.holes = '홀 수는 9~72 사이 숫자로 입력해주세요.';
      const duplicate = masterCourses().find(item => normalizeName(item.name) === normalizeName(course.name) && course.name.length > 1);
      if (duplicate) errors.courseName = `이미 등록된 골프장입니다. 목록에서 '${duplicate.name}'을 선택해주세요.`;
      const pending = pendingFor(list, item => item.courseMode === 'new' && normalizeName(item.course?.name) === normalizeName(course.name));
      if (pending) errors.courseName = `이미 검토 중인 신청이 있습니다. (접수번호 ${pending.id})`;
    }

    const managerName = text(input?.managerName);
    const managerPhone = text(input?.managerPhone);
    const managerEmail = text(input?.managerEmail);
    const managerRole = text(input?.managerRole);
    if (managerName.length < 2 || managerName.length > 20) errors.managerName = '담당자명을 2~20자로 입력해주세요.';
    if (!isPhone(managerPhone)) errors.managerPhone = '휴대전화번호 형식이 올바르지 않습니다. 예: 010-1234-5678';
    if (!isEmail(managerEmail)) errors.managerEmail = '이메일 형식이 올바르지 않습니다.';
    if (managerRole.length > 20) errors.managerRole = '직책은 20자 이하로 입력해주세요.';

    const conditions = {
      weekdayGreenFee: moneyValue(input?.weekdayGreenFee),
      weekendGreenFee: moneyValue(input?.weekendGreenFee),
      cartFee: moneyValue(input?.cartFee),
      caddieFee: moneyValue(input?.caddieFee),
      teeInterval: moneyValue(input?.teeInterval),
      memo: text(input?.memo)
    };
    ['weekdayGreenFee', 'weekendGreenFee', 'cartFee', 'caddieFee'].forEach(field => {
      if (Number.isNaN(conditions[field])) errors[field] = '금액은 0원 이상 숫자로 입력해주세요.';
    });
    if (Number.isNaN(conditions.teeInterval) || conditions.teeInterval != null && (conditions.teeInterval < 5 || conditions.teeInterval > 30)) errors.teeInterval = '티오프 간격은 5~30분으로 입력해주세요.';
    if (conditions.memo.length > MAX_MEMO) errors.memo = `운영 조건 메모는 ${MAX_MEMO}자 이하로 입력해주세요.`;
    if (input?.agree !== true) errors.agree = '제휴 조건 확인 및 시연용 안내에 동의해주세요.';

    const keys = Object.keys(errors);
    return {
      ok: keys.length === 0,
      errors,
      message: keys.length ? errors[keys[0]] : '',
      value: { mode, courseId, course, manager: { name: managerName, role: managerRole, phone: managerPhone, email: managerEmail }, conditions }
    };
  };

  const submit = input => {
    const list = read();
    const checked = validate(input, list);
    if (!checked.ok) return { ok: false, errors: checked.errors, message: checked.message };
    const { mode, courseId, course, manager, conditions } = checked.value;
    const now = new Date().toISOString();
    const application = {
      id: receiptId(list),
      status: 'pending',
      courseMode: mode,
      courseId: mode === 'existing' ? courseId : null,
      newCourseId: mode === 'new' ? newCourseId(list) : null,
      course,
      manager,
      conditions,
      agreeAt: now,
      decision: null,
      createdAt: now,
      updatedAt: now,
      dataMode: 'demo'
    };
    list.push(application);
    write(list);
    return { ok: true, application: { ...application } };
  };

  const markPartnershipComplete = (application, at) => {
    if (application.courseMode !== 'existing' || !application.courseId) return;
    let map = {};
    try {
      const parsed = JSON.parse(localStorage.getItem(PARTNERSHIP_KEY) || '{}');
      map = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { map = {}; }
    map[application.courseId] = { status: 'complete', note: `제휴 신청 승인 (${application.id})`, updatedAt: at };
    localStorage.setItem(PARTNERSHIP_KEY, JSON.stringify(map));
  };

  const decide = (id, status, options = {}) => {
    if (!['approved', 'rejected'].includes(status)) return { ok: false, message: '지원하지 않는 처리 상태입니다.' };
    const list = read();
    const index = list.findIndex(item => item.id === text(id));
    if (index < 0) return { ok: false, message: '신청을 찾을 수 없습니다.' };
    const current = list[index];
    if (current.status !== 'pending') return { ok: false, message: `이미 ${STATUS_LABELS[current.status] || '처리'}된 신청입니다.` };
    const reason = text(options.reason);
    if (status === 'rejected' && !reason) return { ok: false, message: '반려 사유를 입력해주세요.' };
    const at = new Date().toISOString();
    const decision = { at, by: text(options.by) || '본사 관리자', memo: text(options.memo) || (status === 'rejected' ? reason : ''), reason: status === 'rejected' ? reason : '' };
    const application = { ...current, status, decision, updatedAt: at };
    list[index] = application;
    write(list);
    if (status === 'approved') markPartnershipComplete(application, at);
    return { ok: true, application: { ...application } };
  };
  const approve = (id, options = {}) => decide(id, 'approved', options);
  const reject = (id, options = {}) => decide(id, 'rejected', { ...options, reason: options?.reason });

  const list = () => read().map(item => ({ ...item, statusLabel: STATUS_LABELS[item.status] || item.status, modeLabel: MODE_LABELS[item.courseMode] || item.courseMode })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const get = id => { const found = read().find(item => item.id === text(id)); return found ? { ...found, statusLabel: STATUS_LABELS[found.status] || found.status, modeLabel: MODE_LABELS[found.courseMode] || found.courseMode } : null; };
  const statusOf = receipt => get(receipt);
  const stats = () => {
    const all = read();
    return {
      total: all.length,
      pending: all.filter(item => item.status === 'pending').length,
      approved: all.filter(item => item.status === 'approved').length,
      rejected: all.filter(item => item.status === 'rejected').length
    };
  };
  const pendingCount = () => read().filter(item => item.status === 'pending').length;
  const availableCourses = () => masterCourses().filter(item => !isPartnerCourse(item.id));

  window.ALL_GOLF_PARTNER_STORE = {
    KEY, PARTNERSHIP_KEY, STATUS_LABELS, MODE_LABELS, MAX_MEMO,
    isPhone, isEmail, normalizeName,
    list, get, statusOf, stats, pendingCount,
    submit, approve, reject, decide,
    partnerIds, isPartnerCourse, partneredCourseCount, defaultPartnerIds,
    approvedCourses, demoTimesFor, availableCourses,
    courseIdOf
  };
})();
