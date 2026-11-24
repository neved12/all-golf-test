'use strict';
/* ALL:GOLF 파일 기반 DB
   - 모든 변경은 프로세스 내 큐 + 파일 잠금(.lock)으로 한 번에 하나씩 처리한다.
   - 저장은 임시 파일 + fsync + rename(원자적 교체)으로 중간에 꺼져도 반쯤 쓰인 JSON이 남지 않는다.
   - 읽기는 매번 디스크에서 새로 읽어 다른 프로세스의 변경도 즉시 반영한다.
   - JSON이 깨져 있으면 조용히 초기화하지 않고, 백업 위치를 알려주며 멈춘다(데이터 보존). */

const fs = require('fs');
const path = require('path');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function emptyDatabase() {
  return {
    version: 1,
    meta: { createdAt: new Date().toISOString(), updatedAt: null, revision: 0, sequences: {}, lastBackupDate: null },
    applications: [],
    approvedCourses: [],
    auditLogs: []
  };
}

function normalizeDatabase(raw) {
  const db = raw && typeof raw === 'object' ? raw : {};
  db.version = Number(db.version) || 1;
  db.meta = db.meta && typeof db.meta === 'object' ? db.meta : {};
  db.meta.createdAt = db.meta.createdAt || new Date().toISOString();
  db.meta.updatedAt = db.meta.updatedAt || null;
  db.meta.revision = Number(db.meta.revision) || 0;
  db.meta.sequences = db.meta.sequences && typeof db.meta.sequences === 'object' ? db.meta.sequences : {};
  db.applications = Array.isArray(db.applications) ? db.applications : [];
  db.approvedCourses = Array.isArray(db.approvedCourses) ? db.approvedCourses : [];
  db.auditLogs = Array.isArray(db.auditLogs) ? db.auditLogs : [];
  return db;
}

class Store {
  constructor(options = {}) {
    this.file = options.file;
    this.backupDir = options.backupDir || path.join(path.dirname(this.file), 'backups');
    this.seedFile = options.seedFile || path.join(__dirname, '..', 'data', 'db.seed.json');
    this.autoBackup = options.autoBackup !== false;
    this.timeoutMs = Number(options.lockTimeoutMs) || 8000;
    this.queue = Promise.resolve();
  }

  /* 초기 준비: 폴더와 DB 파일이 없으면 시드로 만든다. */
  init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
    if (!fs.existsSync(this.file)) {
      let seed = emptyDatabase();
      try {
        if (fs.existsSync(this.seedFile)) seed = normalizeDatabase(JSON.parse(fs.readFileSync(this.seedFile, 'utf8')));
      } catch { seed = emptyDatabase(); }
      if (!seed.meta.createdAt) seed.meta.createdAt = new Date().toISOString();
      this.writeAtomic(seed);
      return { created: true, file: this.file };
    }
    this.read();
    return { created: false, file: this.file };
  }

  read() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.writeAtomic(emptyDatabase());
        return this.read();
      }
      throw error;
    }
    try {
      return normalizeDatabase(JSON.parse(text));
    } catch (error) {
      const corrupt = `${this.file}.corrupt-${Date.now()}.json`;
      try { fs.copyFileSync(this.file, corrupt); } catch { /* 복사 실패는 무시하고 원본 유지 */ }
      const backup = this.latestBackup();
      const failure = new Error(
        `DB 파일을 읽을 수 없습니다: ${this.file}\n` +
        `원본을 ${corrupt} 로 복사해 두었습니다.\n` +
        (backup ? `복구하려면 npm run db:restore -- ${backup}` : '사용 가능한 백업이 없습니다. server/data/README.md 를 확인하세요.')
      );
      failure.code = 'DB_CORRUPT';
      failure.corruptFile = corrupt;
      failure.backup = backup;
      throw failure;
    }
  }

  status() {
    const db = this.read();
    return {
      applications: db.applications.length,
      pending: db.applications.filter(item => item.status === 'pending').length,
      approvedCourses: db.approvedCourses.length,
      auditLogs: db.auditLogs.length,
      revision: db.meta.revision,
      updatedAt: db.meta.updatedAt
    };
  }

  latestBackup() {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(name => /^db-.*\.json$/.test(name))
        .sort();
      return files.length ? path.join(this.backupDir, files[files.length - 1]) : null;
    } catch { return null; }
  }

  writeAtomic(db) {
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const json = `${JSON.stringify(db, null, 2)}\n`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, json);
      try { fs.fsyncSync(fd); } catch { /* 일부 파일시스템은 fsync 미지원 */ }
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, this.file);
    } catch (error) {
      /* Windows 에서 대상 파일이 열려 있으면 rename 이 실패할 수 있다.
         이때는 내용 복사 후 임시 파일을 지우는 방식으로 대체한다. */
      if (!['EPERM', 'EEXIST', 'EACCES', 'EBUSY'].includes(error.code)) {
        try { fs.unlinkSync(tmp); } catch { /* noop */ }
        throw error;
      }
      fs.copyFileSync(tmp, this.file);
      try { fs.unlinkSync(tmp); } catch { /* noop */ }
    }
    try {
      const dirFd = fs.openSync(path.dirname(this.file), 'r');
      try { fs.fsyncSync(dirFd); } catch { /* noop */ }
      fs.closeSync(dirFd);
    } catch { /* 디렉터리 fsync 는 지원되지 않을 수 있다 */ }
  }

  /* 변경 트랜잭션: 큐 → 파일 잠금 → 최신 읽기 → 변경 → 원자적 저장 */
  async update(mutator) {
    const run = async () => {
      const release = await this.acquireLockAsync();
      try {
        const db = this.read();
        if (this.autoBackup) this.maybeDailyBackup(db);
        const result = await mutator(db);
        db.meta.revision = (Number(db.meta.revision) || 0) + 1;
        db.meta.updatedAt = new Date().toISOString();
        this.writeAtomic(normalizeDatabase(db));
        return { result, db };
      } finally {
        release();
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async acquireLockAsync() {
    const lockFile = `${this.file}.lock`;
    const start = Date.now();
    for (;;) {
      try {
        const fd = fs.openSync(lockFile, 'wx');
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        fs.closeSync(fd);
        return () => { try { fs.unlinkSync(lockFile); } catch { /* noop */ } };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const stat = fs.statSync(lockFile);
          if (Date.now() - stat.mtimeMs > 15000) { fs.unlinkSync(lockFile); continue; }
        } catch { /* noop */ }
        if (Date.now() - start > this.timeoutMs) {
          const failure = new Error('DB 잠금을 기다리다 시간이 초과되었습니다. 다른 서버 프로세스가 실행 중인지 확인하세요.');
          failure.code = 'DB_LOCK_TIMEOUT';
          throw failure;
        }
        await sleep(20 + Math.floor(Math.random() * 30));
      }
    }
  }

  maybeDailyBackup(db) {
    if (!db.applications.length && !db.auditLogs.length) return;
    const today = new Date().toISOString().slice(0, 10);
    if (db.meta.lastBackupDate === today) return;
    try {
      const target = path.join(this.backupDir, `db-${today}.json`);
      if (!fs.existsSync(target)) fs.copyFileSync(this.file, target);
      db.meta.lastBackupDate = today;
    } catch { /* 백업 실패가 저장을 막지는 않는다 */ }
  }

  async backup(tag = 'manual') {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const target = path.join(this.backupDir, `db-${stamp}-${tag}.json`);
    const db = this.read();
    fs.writeFileSync(target, `${JSON.stringify(db, null, 2)}\n`);
    return target;
  }

  async restore(sourceFile) {
    if (!fs.existsSync(sourceFile)) throw new Error(`백업 파일을 찾을 수 없습니다: ${sourceFile}`);
    const parsed = normalizeDatabase(JSON.parse(fs.readFileSync(sourceFile, 'utf8')));
    if (!Array.isArray(parsed.applications)) throw new Error('백업 파일 형식이 올바르지 않습니다.');
    const release = await this.acquireLockAsync();
    try {
      if (fs.existsSync(this.file)) {
        fs.mkdirSync(this.backupDir, { recursive: true });
        const keep = path.join(this.backupDir, `db-before-restore-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
        fs.copyFileSync(this.file, keep);
      }
      parsed.meta.revision = (Number(parsed.meta.revision) || 0) + 1;
      parsed.meta.updatedAt = new Date().toISOString();
      this.writeAtomic(parsed);
      return { restoredFrom: sourceFile, counts: { applications: parsed.applications.length } };
    } finally {
      release();
    }
  }
}

module.exports = { Store, emptyDatabase, normalizeDatabase };
