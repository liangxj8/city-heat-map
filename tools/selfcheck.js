#!/usr/bin/env node
/**
 * tools/selfcheck.js
 * ---------------------------------------------------------------------------
 * 交付前自检脚本：在 Node 环境里模拟浏览器加载 data/*.js，校验：
 *   1. 三个前端 JS 文件语法是否合法（node --check 由外部执行）
 *   2. window.CHINA_GEO 是否为合法 FeatureCollection
 *   3. window.CITIES 条数、字段完整性、heat 范围、crowd 推导一致性
 *   4. 经纬度是否落在中国范围内（lng 73-136，lat 3-54）
 *   5. 省份简称是否全部能对应到 GeoJSON 的省级全称
 *   6. 是否存在重复城市名
 *   7. index.html 引用的 DOM id 是否都能在 assets/app.js 中找到
 *   8. 是否残留 fetch( / XMLHttpRequest 调用（file:// 下会失败）
 *
 * 用法： node tools/selfcheck.js
 * ---------------------------------------------------------------------------
 */

'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.resolve(__dirname, '..');

/** 省级行政区「简称 -> GeoJSON 全称」，需与 assets/app.js 中保持一致。 */
var PROVINCE_FULL_NAME = {
  '北京': '北京市', '天津': '天津市', '河北': '河北省', '山西': '山西省',
  '内蒙古': '内蒙古自治区', '辽宁': '辽宁省', '吉林': '吉林省', '黑龙江': '黑龙江省',
  '上海': '上海市', '江苏': '江苏省', '浙江': '浙江省', '安徽': '安徽省',
  '福建': '福建省', '江西': '江西省', '山东': '山东省', '河南': '河南省',
  '湖北': '湖北省', '湖南': '湖南省', '广东': '广东省', '广西': '广西壮族自治区',
  '海南': '海南省', '重庆': '重庆市', '四川': '四川省', '贵州': '贵州省',
  '云南': '云南省', '西藏': '西藏自治区', '陕西': '陕西省', '甘肃': '甘肃省',
  '青海': '青海省', '宁夏': '宁夏回族自治区', '新疆': '新疆维吾尔自治区',
  '台湾': '台湾省', '香港': '香港特别行政区', '澳门': '澳门特别行政区'
};

/** 必填字段列表。 */
var REQUIRED_FIELDS = [
  'name', 'province', 'lng', 'lat', 'heat', 'crowd',
  'delta', 'tags', 'reason', 'tip', 'days', 'spots'
];

var errors = [];
var warnings = [];

/**
 * 记录一条错误。
 * @param {string} msg 错误信息。
 * @returns {void}
 */
function fail(msg) { errors.push(msg); }

/**
 * 记录一条警告。
 * @param {string} msg 警告信息。
 * @returns {void}
 */
function warn(msg) { warnings.push(msg); }

/**
 * 在沙箱里执行一个声明 window.* 变量的 JS 文件，返回沙箱上下文。
 * @param {string} relPath 相对项目根目录的路径。
 * @returns {Object} 沙箱全局对象。
 */
function loadIntoWindow(relPath) {
  var full = path.join(ROOT, relPath);
  var code = fs.readFileSync(full, 'utf8');
  var sandbox = {};
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.console = console;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: full });
  return sandbox;
}

// ---------------------------------------------------------------- 1. 边界数据
var geoSandbox = loadIntoWindow(path.join('data', 'geo.js'));
var geo = geoSandbox.CHINA_GEO;
if (!geo || geo.type !== 'FeatureCollection' || !Array.isArray(geo.features)) {
  fail('data/geo.js 未导出合法的 window.CHINA_GEO');
} else {
  console.log('[geo] 要素数量: ' + geo.features.length);
  var geoNames = geo.features.map(function (f) { return f.properties.name; });
  console.log('[geo] 省级名称: ' + geoNames.join('、'));
  geoNames.forEach(function (n) {
    if (!n) { fail('GeoJSON 中存在空 name 要素'); }
  });
}

// ---------------------------------------------------------------- 2. 城市数据
var citySandbox = loadIntoWindow(path.join('data', 'cities.js'));
var cities = citySandbox.CITIES || [];

console.log('');
console.log('[cities] 总条数: ' + cities.length);
var provinces = [];
cities.forEach(function (c) {
  if (provinces.indexOf(c.province) === -1) { provinces.push(c.province); }
});
console.log('[cities] 覆盖省级数: ' + provinces.length);
console.log('[cities] 省级列表: ' + provinces.join('/'));

if (cities.length < 320) {
  fail('城市条数不足 320，当前 ' + cities.length);
}
if (provinces.length < 34) {
  fail('省级行政区覆盖不足 34 个，当前 ' + provinces.length);
}

// 字段完整性 / 取值范围 / crowd 一致性
var seenNames = {};
var heatBuckets = { '冷清<30': 0, '舒适30-49': 0, '适中50-69': 0, '拥挤70-84': 0, '爆满>=85': 0 };

cities.forEach(function (c) {
  REQUIRED_FIELDS.forEach(function (field) {
    if (c[field] === undefined || c[field] === null) {
      fail('字段缺失: ' + (c.name || '?') + ' 缺少 ' + field);
    }
  });

  if (seenNames[c.name]) {
    fail('城市名重复: ' + c.name);
  }
  seenNames[c.name] = true;

  if (typeof c.heat !== 'number' || !isFinite(c.heat) || c.heat < 0 || c.heat > 100 ||
      Math.floor(c.heat) !== c.heat) {
    fail('heat 非法: ' + c.name + ' = ' + c.heat);
  }

  if (typeof c.lng !== 'number' || typeof c.lat !== 'number' ||
      c.lng < 73 || c.lng > 136 || c.lat < 3 || c.lat > 54) {
    fail('经纬度越界: ' + c.name + ' (' + c.lng + ', ' + c.lat + ')');
  }

  if (!Array.isArray(c.tags) || c.tags.length === 0) {
    fail('tags 非法: ' + c.name);
  }
  if (!Array.isArray(c.spots) || c.spots.length < 2 || c.spots.length > 4) {
    fail('spots 数量需在 2-4 之间: ' + c.name + ' = ' + (c.spots || []).length);
  }
  if (typeof c.delta !== 'number' || !isFinite(c.delta)) {
    fail('delta 非法: ' + c.name);
  }

  var expect;
  if (c.heat >= 85) { expect = '爆满'; heatBuckets['爆满>=85']++; }
  else if (c.heat >= 70) { expect = '拥挤'; heatBuckets['拥挤70-84']++; }
  else if (c.heat >= 50) { expect = '适中'; heatBuckets['适中50-69']++; }
  else if (c.heat >= 30) { expect = '舒适'; heatBuckets['舒适30-49']++; }
  else { expect = '冷清'; heatBuckets['冷清<30']++; }
  if (c.crowd !== expect) {
    fail('crowd 与 heat 不一致: ' + c.name + ' heat=' + c.heat +
      ' crowd=' + c.crowd + ' 应为 ' + expect);
  }

  if (!PROVINCE_FULL_NAME[c.province]) {
    fail('省份简称无法映射: ' + c.name + ' -> ' + c.province);
  }
});

console.log('[cities] 热度分布: ' + JSON.stringify(heatBuckets, null, 0));

// 省份简称 -> GeoJSON 全称 对应关系
if (geo && geo.features) {
  var geoSet = {};
  geo.features.forEach(function (f) { geoSet[f.properties.name] = true; });
  Object.keys(PROVINCE_FULL_NAME).forEach(function (shortName) {
    var full = PROVINCE_FULL_NAME[shortName];
    if (!geoSet[full]) {
      fail('GeoJSON 中缺少对应要素: ' + shortName + ' -> ' + full);
    }
  });
  provinces.forEach(function (p) {
    var full = PROVINCE_FULL_NAME[p];
    if (full && !geoSet[full]) {
      fail('城市省份在 GeoJSON 中不存在: ' + p);
    }
  });
}

// ---------------------------------------------------------------- 3. 静态资源
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var appJs = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');

// 检查 index.html 引用的本地资源是否存在
var refPattern = /(?:src|href)="([^"]+)"/g;
var match = null;
while ((match = refPattern.exec(html)) !== null) {
  var ref = match[1];
  if (/^https?:\/\//.test(ref) || ref.charAt(0) === '#') { continue; }
  if (!fs.existsSync(path.join(ROOT, ref))) {
    fail('index.html 引用的文件不存在: ' + ref);
  }
}

// 检查是否残留网络请求（file:// 下会失败）
if (/fetch\s*\(/.test(appJs) || /XMLHttpRequest/.test(appJs)) {
  fail('assets/app.js 中存在 fetch( 或 XMLHttpRequest，file:// 下会被 CORS 拦截');
}
if (/\bfetch\s*\(/.test(html)) {
  fail('index.html 中存在 fetch( 调用');
}
if (/https?:\/\/(?!www\.w3\.org)/.test(html.replace(/<!--[\s\S]*?-->/g, ''))) {
  var urls = html.match(/https?:\/\/[^\s"']+/g) || [];
  var external = urls.filter(function (u) { return u.indexOf('www.w3.org') === -1; });
  if (external.length) {
    warn('index.html 中发现外链（应确保离线可用）: ' + external.join(', '));
  }
}

// 检查 app.js 中 getElementById 引用的 id 是否都在 index.html 中存在
var htmlIds = {};
var idPattern = /\bid="([^"]+)"/g;
while ((match = idPattern.exec(html)) !== null) {
  htmlIds[match[1]] = true;
}
var usedIds = {};
var gidPattern = /getElementById\(['"]([^'"]+)['"]\)/g;
while ((match = gidPattern.exec(appJs)) !== null) {
  usedIds[match[1]] = true;
}
Object.keys(usedIds).forEach(function (id) {
  if (id === 'btn-locate' || id === 'btn-only-province' || id === 'map') {
    // btn-locate / btn-only-province 由 renderDetail 动态生成；map 在 html 中存在
    if (id === 'map' && !htmlIds[id]) { fail('index.html 缺少 id: ' + id); }
    return;
  }
  if (!htmlIds[id]) {
    fail('assets/app.js 引用了 index.html 中不存在的 id: ' + id);
  }
});

// 检查 querySelector 引用的 class 是否存在
// 由 JS 动态生成的元素，其 class 不会出现在 index.html 中，属于预期情况
var DYNAMIC_CLASSES = ['suggest-item'];
var qsPattern = /querySelector(?:All)?\(['"]\.([a-z0-9-]+)['"]\)/g;
while ((match = qsPattern.exec(appJs)) !== null) {
  var cls = match[1];
  if (DYNAMIC_CLASSES.indexOf(cls) !== -1) { continue; }
  if (html.indexOf('class="' + cls) === -1 && html.indexOf(' ' + cls + '"') === -1 &&
      html.indexOf(cls + '"') === -1) {
    warn('assets/app.js querySelector 的 class 未在 index.html 出现: .' + cls);
  }
}

// ---------------------------------------------------------------- 4. 汇总
console.log('');
console.log('=== 自检汇总 ===');
if (warnings.length) {
  console.log('警告 ' + warnings.length + ' 条:');
  warnings.forEach(function (w) { console.log('  [WARN] ' + w); });
}
if (errors.length) {
  console.log('错误 ' + errors.length + ' 条:');
  errors.forEach(function (e) { console.log('  [FAIL] ' + e); });
  console.log('RESULT: FAIL');
  process.exit(1);
}
console.log('错误 0 条');
console.log('RESULT: PASS');
