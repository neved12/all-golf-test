#!/usr/bin/env node
/* ALL:GOLF 로컬 개발 서버 (의존성 없음)
   사용법: node dev-server.js   (기본 포트 4173, PORT 환경변수로 변경)
   - 저장소 루트를 그대로 서빙한다. / 는 index.html, /admin/ 은 admin/index.html.
   - 테스트가 끝나면 Ctrl+C 로 종료한다. */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.ics': 'text/calendar; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(function (request, response) {
  let pathname = '/';
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://' + (request.headers.host || 'localhost')).pathname);
  } catch (error) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Bad request');
    return;
  }

  let filePath = path.join(root, pathname === '/' ? 'index.html' : pathname);
  if (filePath.indexOf(root) !== 0) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Forbidden');
    return;
  }

  fs.stat(filePath, function (statError, stat) {
    if (!statError && stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, function (readError, buffer) {
      if (readError) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found: ' + pathname);
        return;
      }
      const type = types[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      response.end(buffer);
    });
  });
});

server.listen(port, host, function () {
  console.log('ALL:GOLF dev server → http://' + host + ':' + port + '/');
  console.log('본사 관리자 → /admin/ , 골프장 관리자 → /partner/ , 시나리오 테스트 → node tests/run-scenarios.js');
});
