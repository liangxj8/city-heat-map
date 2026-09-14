/* eslint-disable no-console */
/**
 * QA 数据完整性校验脚本（Round 1）
 * 用法：node tools/qa-validate-data.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const failures = [];
const warnings = [];
let passed = 0;

function assert(cond, msg) {
  if (cond) { passed += 1; } else { failures.push(msg); }
}
function warn(cond, msg) {
  if (!cond) { warnings.push(msg); }
}

// ---------------------------------------------------------------- 加载数据
// data/geo.js 直接写 window.CHINA_GEO，Node 下需先注入 window 别名。
global.window = global;
require(path.join(ROOT, 'data', 'cities.js'));
require(path.join(ROOT, 'data', 'geo.js'));

const CITIES = global.CITIES || globalThis.CITIES;
const GEO = global.CHINA_GEO || globalThis.CHINA_GEO;

assert(Array.isArray(CITIES) && CITIES.length > 0, 'CITIES 未加载或为空');
assert(!!GEO && Array.isArray(GEO.features), 'CHINA_GEO.features 未加载');

// ---------------------------------------------------------------- 1. 条数
assert(CITIES.length >= 320, `城市条数应 >=320，实际 ${CITIES.length}`);

// ---------------------------------------------------------------- 2. 省级覆盖
const PROVINCES = ['北京', '天津', '河北', '山西', '内蒙古', '辽宁', '吉林', '黑龙江',
  '上海', '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南',
  '湖北', '湖南', '广东', '广西', '海南', '重庆', '四川', '贵州',
  '云南', '西藏', '陕西', '甘肃', '青海', '宁夏', '新疆',
  '台湾', '香港', '澳门'];

const provinceSet = new Set(CITIES.map((c) => c.province));
PROVINCES.forEach((p) => {
  assert(provinceSet.has(p), `缺少省级行政区：${p}`);
});
assert(provinceSet.size === 34, `省级行政区数量应为 34，实际 ${provinceSet.size}`);
const extra = [...provinceSet].filter((p) => PROVINCES.indexOf(p) === -1);
assert(extra.length === 0, `存在非法省份名：${extra.join(',')}`);

// ---------------------------------------------------------------- 3. 字段 / 取值
const REQUIRED = ['name', 'province', 'lng', 'lat', 'heat', 'delta', 'tags', 'reason', 'tip', 'days', 'spots', 'crowd', 'src', 'raw'];

/** 合法的热度来源标记。 */
// official = 三峡专题点位（奉节/巫山/巴东/秭归），数据来自地方官方假日旅游统计，
// 没有百度迁徙原始指数，raw 为 null、heat 为占位值，且不参与热度排名与统计。
const VALID_SRC = ['real', 'province', 'median', 'official'];

/**
 * delta 是否为一位小数（真实同比 = 两年日均指数之差，保留 1 位）。
 * @param {number} value 待判定值。
 * @returns {boolean} 是否为一位小数。
 */
function isOneDecimal(value) {
  return Number.isFinite(value) && Math.abs(value * 10 - Math.round(value * 10)) < 1e-9;
}

function crowdOf(heat) {
  if (heat >= 85) { return '爆满'; }
  if (heat >= 70) { return '拥挤'; }
  if (heat >= 50) { return '适中'; }
  if (heat >= 30) { return '舒适'; }
  return '冷清';
}

const nameSet = new Set();
const dupNames = [];
const badHeat = [];
const badCoord = [];
const badField = [];
const badCrowd = [];
const badType = [];

CITIES.forEach((c, i) => {
  const tag = `#${i} ${c && c.name ? c.name : '(无名)'}`;
  REQUIRED.forEach((f) => {
    // 三峡专题点位拿不到迁徙原始指数，raw 允许为 null。
    if (c.src === 'official' && f === 'raw') { return; }
    if (c[f] === undefined || c[f] === null || c[f] === '') { badField.push(`${tag} 缺字段 ${f}`); }
  });
  if (!Number.isInteger(c.heat) || c.heat < 0 || c.heat > 100) { badHeat.push(`${tag} heat=${c.heat}`); }
  if (!Number.isFinite(c.lng) || c.lng < 73 || c.lng > 136) { badCoord.push(`${tag} lng=${c.lng}`); }
  if (!Number.isFinite(c.lat) || c.lat < 3 || c.lat > 54) { badCoord.push(`${tag} lat=${c.lat}`); }
  if (crowdOf(c.heat) !== c.crowd) { badCrowd.push(`${tag} heat=${c.heat} crowd=${c.crowd} 应为 ${crowdOf(c.heat)}`); }
  if (!Array.isArray(c.tags) || !c.tags.length) { badType.push(`${tag} tags 非数组`); }
  if (!Array.isArray(c.spots) || c.spots.length < 2) { badType.push(`${tag} spots 少于 2 个`); }
  if (!isOneDecimal(c.delta)) { badType.push(`${tag} delta 非一位小数：${c.delta}`); }
  if (VALID_SRC.indexOf(c.src) === -1) { badType.push(`${tag} src 非法：${c.src}`); }
  if (c.src !== 'official') {
    if (typeof c.raw !== 'number' || !isFinite(c.raw) || c.raw < 0) { badType.push(`${tag} raw 非法：${c.raw}`); }
    if (Math.abs(c.raw * 1000 - Math.round(c.raw * 1000)) > 1e-6) { badType.push(`${tag} raw 不是三位小数：${c.raw}`); }
  }
  // 三峡专题点位必须带有 official 数据对象，且字段齐全。
  if (c.src === 'official') {
    const o = c.official;
    if (!o || !Number.isFinite(o.value) || !o.unit || !o.caliber || !o.detail || !o.source) {
      badType.push(`${tag} official 数据不完整`);
    }
  }
  if (nameSet.has(c.name)) { dupNames.push(c.name); }
  nameSet.add(c.name);
});

assert(badField.length === 0, `字段缺失：\n    ${badField.slice(0, 10).join('\n    ')}`);
assert(badHeat.length === 0, `heat 越界/非整数：${badHeat.slice(0, 10).join('; ')}`);
assert(badCoord.length === 0, `经纬度越界：${badCoord.slice(0, 10).join('; ')}`);
assert(badCrowd.length === 0, `crowd 与 heat 分级不一致：\n    ${badCrowd.slice(0, 10).join('\n    ')}`);
assert(badType.length === 0, `字段类型异常：\n    ${badType.slice(0, 10).join('\n    ')}`);
assert(dupNames.length === 0, `重复城市名：${[...new Set(dupNames)].join(', ')}`);

// raw（原始迁入规模指数）与 heat 必须单调一致：归一化映射是单调递增的，
// 因此按 raw 升序排列时 heat 不应出现下降（允许相等，因为 p2/p98 处做了截断）。
// 三峡专题点位没有 raw，不参与单调性检查。
const byRaw = CITIES.filter((c) => c.src !== 'official').slice().sort((a, b) => a.raw - b.raw);
let monotonic = true;
for (let i = 1; i < byRaw.length; i += 1) {
  if (byRaw[i].heat < byRaw[i - 1].heat) {
    monotonic = false;
    failures.push(`heat 与 raw 排序不一致：${byRaw[i - 1].name}(raw=${byRaw[i - 1].raw}, heat=${byRaw[i - 1].heat})`
      + ` -> ${byRaw[i].name}(raw=${byRaw[i].raw}, heat=${byRaw[i].heat})`);
    break;
  }
}
assert(monotonic, 'heat 与 raw 排序不一致（归一化映射应为单调递增）');

// ---------------------------------------------------------------- 4. GeoJSON
const FULL_NAME = {
  北京: '北京市', 天津: '天津市', 河北: '河北省', 山西: '山西省',
  内蒙古: '内蒙古自治区', 辽宁: '辽宁省', 吉林: '吉林省', 黑龙江: '黑龙江省',
  上海: '上海市', 江苏: '江苏省', 浙江: '浙江省', 安徽: '安徽省',
  福建: '福建省', 江西: '江西省', 山东: '山东省', 河南: '河南省',
  湖北: '湖北省', 湖南: '湖南省', 广东: '广东省', 广西: '广西壮族自治区',
  海南: '海南省', 重庆: '重庆市', 四川: '四川省', 贵州: '贵州省',
  云南: '云南省', 西藏: '西藏自治区', 陕西: '陕西省', 甘肃: '甘肃省',
  青海: '青海省', 宁夏: '宁夏回族自治区', 新疆: '新疆维吾尔自治区',
  台湾: '台湾省', 香港: '香港特别行政区', 澳门: '澳门特别行政区'
};

const geoNames = new Set(GEO.features.map((f) => f.properties && f.properties.name));
const missingGeo = Object.keys(FULL_NAME).filter((k) => !geoNames.has(FULL_NAME[k]));
assert(missingGeo.length === 0, `GeoJSON 缺少区域：${missingGeo.join(', ')}`);
assert(GEO.features.length >= 34, `GeoJSON features 应 >=34，实际 ${GEO.features.length}`);

const noCenter = GEO.features.filter((f) => {
  const s = Object.keys(FULL_NAME).find((k) => FULL_NAME[k] === f.properties.name);
  return s && (!Array.isArray(f.properties.center) || f.properties.center.length < 2);
}).map((f) => f.properties.name);
assert(noCenter.length === 0, `GeoJSON 缺少 center（会导致省份点击不居中）：${noCenter.join(', ')}`);

// 南海诸岛（DataV 数据中通常为独立 feature 或注释行）
const nanhai = GEO.features.filter((f) => f.properties.name && f.properties.name.indexOf('南海') !== -1);
warn(nanhai.length > 0, 'GeoJSON 未找到「南海诸岛」feature（DataV 100000_full 常缺失，需确认页面是否另行绘制）');

// ---------------------------------------------------------------- 5. 静态回归
const appSrc = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');
['assets/app.js', 'data/geo.js', 'data/cities.js'].forEach((rel) => {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  assert(src.indexOf('fetch(') === -1, `${rel} 中不应出现 fetch(`);
  assert(src.indexOf('XMLHttpRequest') === -1, `${rel} 中不应出现 XMLHttpRequest`);
  // 去掉注释后再检测：注释里出现数据来源 URL 属于正常署名，不构成网络请求。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const remote = code.match(/https?:\/\/[^\s'"`)]+/g) || [];
  assert(remote.length === 0, `${rel} 中存在外部 URL：${[...new Set(remote)].slice(0, 5).join(', ')}`);
});

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

// app.js 在 renderDetail() 中动态注入的按钮 id，不属于 index.html 静态骨架。
const DYNAMIC_IDS = ['btn-locate', 'btn-only-province'];
const dynamicOk = DYNAMIC_IDS.every((id) => appSrc.indexOf("'" + id + "'") !== -1);
assert(dynamicOk, 'app.js 中未找到动态按钮 id 的创建代码（btn-locate / btn-only-province）');

const usedIds = [...appSrc.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
const missingIds = usedIds.filter((id) => !htmlIds.has(id) && DYNAMIC_IDS.indexOf(id) === -1);
assert(missingIds.length === 0, `app.js 引用了 index.html 中不存在的 id：${[...new Set(missingIds)].join(', ')}`);

assert(html.indexOf('src="assets/echarts.min.js"') !== -1, 'index.html 未引入本地 echarts');
const remoteHtml = (html.match(/(?:src|href)="https?:\/\/[^"]+"/g) || []);
assert(remoteHtml.length === 0, `index.html 存在外链资源：${remoteHtml.join(', ')}`);

// ---------------------------------------------------------------- 报告
console.log('\n================ QA 数据校验报告 ================');
console.log(`城市总数：${CITIES.length}｜省级覆盖：${provinceSet.size}/34`);
const lv = { 爆满: 0, 拥挤: 0, 适中: 0, 舒适: 0, 冷清: 0 };
CITIES.forEach((c) => { lv[c.crowd] = (lv[c.crowd] || 0) + 1; });
console.log('等级分布：', JSON.stringify(lv));
console.log(`GeoJSON features：${GEO.features.length}（含南海：${nanhai.length}）`);
console.log(`\n通过断言：${passed}`);
console.log(`失败断言：${failures.length}`);
if (failures.length) {
  console.log('\n--- 失败明细 ---');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
}
if (warnings.length) {
  console.log('\n--- 警告 ---');
  warnings.forEach((w, i) => console.log(`  ${i + 1}. ${w}`));
}
console.log('\n结果：' + (failures.length === 0 ? 'PASS' : 'FAIL'));
process.exit(failures.length === 0 ? 0 : 1);
