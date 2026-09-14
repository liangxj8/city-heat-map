#!/usr/bin/env node
/**
 * tools/smoke-test.js
 * ---------------------------------------------------------------------------
 * 冒烟测试：
 *   1. 用 node --check 校验三个前端 JS 文件的语法
 *   2. 启动一个临时本地静态服务器，依次请求 index.html / assets/*.js / data/*.js
 *      断言全部返回 200 且体积大于阈值，测完立即关闭服务器（不常驻）
 *
 * 用法： node tools/smoke-test.js
 * ---------------------------------------------------------------------------
 */

'use strict';

var fs = require('fs');
var path = require('path');
var http = require('http');
var execFileSync = require('child_process').execFileSync;

var ROOT = path.resolve(__dirname, '..');

/** 需要语法校验的前端 JS 文件。 */
var JS_FILES = [
  'assets/app.js',
  'assets/echarts.min.js',
  'data/geo.js',
  'data/cities.js'
];

/** 需要通过 HTTP 拉取的资源及其最小字节数。 */
var HTTP_TARGETS = [
  { path: '/index.html', min: 2000 },
  { path: '/assets/styles.css', min: 3000 },
  { path: '/assets/app.js', min: 8000 },
  { path: '/assets/echarts.min.js', min: 500000 },
  { path: '/data/geo.js', min: 300000 },
  { path: '/data/cities.js', min: 50000 }
];

/** MIME 类型表。 */
var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

var failures = 0;

/**
 * 输出一行结论。
 * @param {boolean} ok 是否通过。
 * @param {string} label 描述。
 * @param {string} extra 附加信息。
 * @returns {void}
 */
function report(ok, label, extra) {
  if (!ok) { failures++; }
  console.log((ok ? '  [OK]   ' : '  [FAIL] ') + label + (extra ? ' — ' + extra : ''));
}

/**
 * 简单的 HTTP GET。
 * @param {string} url 完整 URL。
 * @returns {Promise<{status: number, length: number}>} 状态码与字节数。
 */
function httpGet(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) {
      var size = 0;
      res.on('data', function (chunk) { size += chunk.length; });
      res.on('end', function () {
        resolve({ status: res.statusCode, length: size });
      });
    }).on('error', reject);
  });
}

/**
 * 主流程。
 * @returns {void}
 */
async function main() {
  console.log('=== 1. JS 语法校验 (node --check) ===');
  JS_FILES.forEach(function (rel) {
    var full = path.join(ROOT, rel);
    try {
      execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
      report(true, rel, (fs.statSync(full).size / 1024).toFixed(1) + ' KB');
    } catch (err) {
      report(false, rel, String(err.stderr || err.message).slice(0, 300));
    }
  });

  console.log('');
  console.log('=== 2. 临时静态服务器冒烟测试 ===');

  var server = http.createServer(function (req, res) {
    var urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') { urlPath = '/index.html'; }
    var filePath = path.join(ROOT, urlPath);
    // 防目录穿越
    if (filePath.indexOf(ROOT) !== 0) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(filePath, function (err, data) {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
      });
      res.end(data);
    });
  });

  await new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', resolve);
  });
  var port = server.address().port;
  var base = 'http://127.0.0.1:' + port;
  console.log('  临时服务器已启动: ' + base);

  for (var i = 0; i < HTTP_TARGETS.length; i++) {
    var target = HTTP_TARGETS[i];
    /* eslint-disable no-await-in-loop */
    var result = await httpGet(base + target.path);
    var ok = result.status === 200 && result.length >= target.min;
    report(ok, target.path,
      'HTTP ' + result.status + ' / ' + (result.length / 1024).toFixed(1) + ' KB' +
      (ok ? '' : ' (期望 >= ' + (target.min / 1024).toFixed(1) + ' KB)'));
    /* eslint-enable no-await-in-loop */
  }

  // 404 兜底验证
  var missing = await httpGet(base + '/not-exist.txt');
  report(missing.status === 404, '/not-exist.txt', 'HTTP ' + missing.status + ' (期望 404)');

  await new Promise(function (resolve) {
    server.close(resolve);
  });
  console.log('  临时服务器已关闭');

  console.log('');
  console.log('=== 冒烟测试结果 ===');
  console.log(failures === 0 ? 'RESULT: PASS' : 'RESULT: FAIL (' + failures + ' 项未通过)');
  if (failures > 0) { process.exit(1); }
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
