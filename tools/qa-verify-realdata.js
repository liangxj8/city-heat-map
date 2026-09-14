/* eslint-disable no-console */
/**
 * QA 真实数据抽样交叉验证（独立验收用）
 *
 * 目的：不信任工程师报告，直接做两件事——
 *   1) 从百度迁徙 historycurve 线上接口重新拉取 2025 国庆 7 天日均迁入指数，
 *      与 data/cities.js 中 heat 反推所依据的原始值比对（用本地 .cache 作为中间参照）。
 *   2) 用团队约定的归一化公式手算 heat，验证与 cities.js 中记录的 heat 一致。
 *
 * 用法：node tools/qa-verify-realdata.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DATES = ['20251001', '20251002', '20251003', '20251004', '20251005', '20251006', '20251007'];

// 归一化参数（来自 data/cities.js 头部注释，团队公示口径）
const P2 = 0.050;
const P98 = 14.211;

/** 对数归一化：与 cities.js 注释口径一致，截断到 [0,100]。 */
function heatOf(v) {
  const raw = (100 * (Math.log(v) - Math.log(P2))) / (Math.log(P98) - Math.log(P2));
  return Math.round(Math.max(0, Math.min(100, raw)));
}

// ---------------------------------------------------------------- 载入数据
global.window = global;
require(path.join(ROOT, 'data', 'cities.js'));
const CITIES = global.CITIES;

// ---------------------------------------------------------------- adcode 映射
/** 从 DataV 缓存构建「城市名 -> adcode」。缓存里可能有 XML 错误桩，需容错。 */
function buildAdcodeMap() {
  const dir = path.join(ROOT, 'data', '.cache');
  const map = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith('datav_')) { continue; }
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
    if (!j || !Array.isArray(j.features)) { continue; }
    for (const ft of j.features) {
      const p = ft.properties || {};
      if (!p.name || !p.adcode) { continue; }
      // 不限 level：直辖市 / 港澳在数据里是省级，也要能匹配上。
      map[p.name] = p.adcode;
      // 同时登记去掉常见后缀的短名，便于用 cities.js 里的简称直接查。
      const short = p.name.replace(/(市|地区|自治州|盟|特别行政区|自治区)$/, '');
      if (short && !map[short]) { map[short] = p.adcode; }
    }
  }
  return map;
}

const ADCODE = buildAdcodeMap();

/**
 * 直辖市 / 特别行政区在 DataV 里是省级，其下只有 district，
 * 因此按城市名查不到，直接用国家标准的省级 adcode。
 */
const PROVINCE_LEVEL_ADCODE = {
  北京: 110000, 天津: 120000, 上海: 310000, 重庆: 500000,
  香港: 810000, 澳门: 820000
};

/** 按城市名找 adcode（容忍「市/地区/自治州/盟」等后缀差异）。 */
function findAdcode(name) {
  if (PROVINCE_LEVEL_ADCODE[name]) { return PROVINCE_LEVEL_ADCODE[name]; }
  if (ADCODE[name]) { return ADCODE[name]; }
  for (const suffix of ['市', '地区', '自治州', '盟', '特别行政区']) {
    if (ADCODE[name + suffix]) { return ADCODE[name + suffix]; }
  }
  const hit = Object.keys(ADCODE).find((k) => k.indexOf(name) === 0);
  return hit ? ADCODE[hit] : null;
}

// ---------------------------------------------------------------- 线上抓取
function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, Referer: 'https://qianxi.baidu.com/' } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('timeout')); });
  });
}

function parseJsonp(text) {
  const s = text.indexOf('(');
  const e = text.lastIndexOf(')');
  if (s < 0 || e < 0) { return null; }
  try { return JSON.parse(text.slice(s + 1, e)); } catch (err) { return null; }
}

/** 拉取某 adcode 的迁入指数并算国庆 7 天日均。 */
async function fetchAvg(adcode) {
  const url = `https://huiyan.baidu.com/migration/historycurve.jsonp?dt=city&id=${adcode}&type=move_in`;
  const json = parseJsonp(await get(url));
  if (!json || json.errno !== 0 || !json.data || !json.data.list) { return null; }
  const list = json.data.list;
  const vals = DATES.map((d) => list[d]).filter((v) => typeof v === 'number');
  if (!vals.length) { return null; }
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** 读本地缓存里的国庆 7 天日均（工程师抓取时的留痕）。 */
function cacheAvg(adcode) {
  const f = path.join(ROOT, 'data', '.cache', `mig_${adcode}.json`);
  if (!fs.existsSync(f)) { return null; }
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
  const list = j && j.list;
  if (!list) { return null; }
  const vals = DATES.map((d) => list[d]).filter((v) => typeof v === 'number');
  if (!vals.length) { return null; }
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ---------------------------------------------------------------- 抽样
const SAMPLES = ['成都', '广州', '北京', '杭州', '三沙', '阿里', '玉树', '香港', '澳门'];

(async () => {
  console.log('\n================ 真实数据抽样交叉验证 ================');
  console.log(`归一化口径：heat = round(100*(ln(v)-ln(${P2}))/(ln(${P98})-ln(${P2})))，截断 [0,100]\n`);

  const rows = [];
  for (const name of SAMPLES) {
    const city = CITIES.find((c) => c.name === name);
    if (!city) { rows.push({ name, err: 'cities.js 中不存在' }); continue; }
    const adcode = findAdcode(name);
    let live = null; let liveErr = null;
    if (adcode) {
      try { live = await fetchAvg(adcode); } catch (e) { liveErr = e.message; }
    }
    const cached = adcode ? cacheAvg(adcode) : null;
    rows.push({
      name, province: city.province, adcode, src: city.src,
      heat: city.heat, delta: city.delta, crowd: city.crowd,
      live, cached, liveErr
    });
    await new Promise((r) => setTimeout(r, 700)); // 控频
  }

  console.log('城市\t省份\tsrc\tadcode\t线上日均\t缓存日均\tcities.js中推导原始值\t手算heat\t实际heat\t判定');
  let mismatch = 0;
  for (const r of rows) {
    if (r.err) { console.log(`${r.name}\t${r.err}`); mismatch++; continue; }
    const ref = r.live !== null ? r.live : r.cached;
    const hand = ref !== null && ref !== undefined ? heatOf(ref) : NaN;
    const ok = Number.isFinite(hand) && hand === r.heat;
    if (!ok) { mismatch++; }
    console.log([
      r.name, r.province, r.src, r.adcode || '(无)',
      r.live !== null ? r.live.toFixed(3) : (r.liveErr || 'N/A'),
      r.cached !== null ? r.cached.toFixed(3) : 'N/A',
      ref !== null && ref !== undefined ? ref.toFixed(3) : 'N/A',
      Number.isFinite(hand) ? hand : 'N/A',
      r.heat,
      ok ? 'OK' : '不一致'
    ].join('\t'));
    // 线上与缓存都拿到时，额外校验两者是否一致（证明缓存未被篡改）
    if (r.live !== null && r.cached !== null) {
      const drift = Math.abs(r.live - r.cached);
      if (drift > 1e-6) { console.log(`    ⚠ ${r.name} 线上与缓存不一致，差值 ${drift.toFixed(6)}`); }
    }
  }

  console.log(`\n抽样 ${rows.length} 个城市，heat 复算不一致 ${mismatch} 个`);
  console.log('结果：' + (mismatch === 0 ? 'PASS' : 'FAIL'));
  process.exit(mismatch === 0 ? 0 : 1);
})();
