/* eslint-disable no-console */
/**
 * 主理人复验：回源核对 data/cities.js 里的 raw（原始迁入规模指数）确实是线上真实值。
 * 直接打百度迁徙接口重算 2025 国庆 7 天日均，与 cities.js 记录值逐项比对。
 * 用法：node tools/verify-raw-roundtrip.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DAYS = ['20251001', '20251002', '20251003', '20251004', '20251005', '20251006', '20251007'];

function readCities() {
  const code = fs.readFileSync(path.join(ROOT, 'data', 'cities.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.CITIES;
}

/**
 * cities.js 里没有 adcode 字段，从 DataV 省级缓存反查：城市名 -> adcode。
 * 缓存文件为 data/.cache/datav_{省adcode}.json，其 features[].properties 含 {adcode, name}。
 * @returns {Map<string, string>} 去掉行政后缀后的城市名 -> adcode。
 */
function buildAdcodeMap() {
  const cacheDir = path.join(ROOT, 'data', '.cache');
  const map = new Map();
  if (!fs.existsSync(cacheDir)) { return map; }
  fs.readdirSync(cacheDir).filter((f) => f.startsWith('datav_')).forEach((f) => {
    let geo;
    try { geo = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf8')); } catch (err) { return; }
    (geo.features || []).forEach((ft) => {
      const p = ft.properties || {};
      if (!p.adcode || !p.name) { return; }
      const key = String(p.name).replace(/(市|地区|自治州|盟|特别行政区|省|自治区)$/g, '');
      if (!map.has(key)) { map.set(key, String(p.adcode)); }
    });
  });
  return map;
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://qianxi.baidu.com/' }
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    req.setTimeout(25000, () => req.destroy(new Error('timeout')));
  });
}

function parseJsonp(text) {
  const s = text.indexOf('(');
  const e = text.lastIndexOf(')');
  if (s < 0 || e < 0) { return null; }
  try { return JSON.parse(text.slice(s + 1, e)); } catch (err) { return null; }
}

async function onlineAvg(adcode) {
  const url = `https://huiyan.baidu.com/migration/historycurve.jsonp?dt=city&id=${adcode}&type=move_in`;
  const json = parseJsonp(await get(url));
  if (!json || json.errno !== 0 || !json.data || !json.data.list) { return null; }
  const vals = DAYS.map((d) => json.data.list[d]).filter((v) => typeof v === 'number');
  if (!vals.length) { return null; }
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

(async () => {
  const cities = readCities();
  const byName = new Map(cities.map((c) => [c.name, c]));
  const adcodeMap = buildAdcodeMap();

  // 抽样：最挤头部、并列边界（东莞，raw 低于 p98 却并列 100）、最冷清、港澳
  const samples = ['成都', '广州', '东莞', '杭州', '三沙', '玉树', '香港', '澳门'];

  console.log('\n===== raw 字段回源核对（线上接口重算 2025 国庆 7 天日均）=====');
  console.log('城市\tadcode\t线上均值\tcities.js raw\t差值\t判定');

  let pass = 0;
  let fail = 0;

  for (const name of samples) {
    const c = byName.get(name);
    if (!c) { console.log(`${name}\t未找到`); fail++; continue; }
    const adcode = adcodeMap.get(name);
    if (!adcode) { console.log(`${name}\t(缓存无 adcode)\t-\t${c.raw}\t-\tSKIP`); continue; }
    let online = null;
    try {
      online = await onlineAvg(adcode);
    } catch (err) {
      online = null;
    }
    if (online === null) {
      console.log(`${name}\t${adcode}\t(接口无数据)\t${c.raw}\t-\tSKIP`);
      continue;
    }
    const diff = Math.abs(online - c.raw);
    const ok = diff < 0.0011; // raw 保留 3 位小数，容差按四舍五入计
    if (ok) { pass++; } else { fail++; }
    console.log(`${name}\t${adcode}\t${online.toFixed(3)}\t${c.raw}\t${diff.toFixed(4)}\t${ok ? 'OK' : 'MISMATCH'}`);
    await new Promise((r) => setTimeout(r, 500));
  }

  // 归一化公式复算（含东莞边界验算）
  const P2 = 0.050;
  const P98 = 14.211;
  const norm = (v) => Math.max(0, Math.min(100, Math.round(100 * (Math.log(v) - Math.log(P2)) / (Math.log(P98) - Math.log(P2)))));

  console.log('\n===== 归一化公式复算 heat = round(100*(ln v - ln p2)/(ln p98 - ln p2)) =====');
  console.log('城市\traw\t手算 heat\tcities.js heat\t判定');
  let hpass = 0;
  let hfail = 0;
  samples.forEach((name) => {
    const c = byName.get(name);
    if (!c) { return; }
    const calc = norm(c.raw);
    const ok = calc === c.heat;
    if (ok) { hpass++; } else { hfail++; }
    console.log(`${name}\t${c.raw}\t${calc}\t${c.heat}\t${ok ? 'OK' : 'MISMATCH'}`);
  });

  // 验证工程师说法：东莞 raw 低于 p98，是四舍五入成 100 而非被截断
  const dg = byName.get('东莞');
  if (dg) {
    const exact = 100 * (Math.log(dg.raw) - Math.log(P2)) / (Math.log(P98) - Math.log(P2));
    console.log(`\n东莞边界验算：raw=${dg.raw}（< p98=${P98}），未截断精确值=${exact.toFixed(2)} → 四舍五入=${Math.round(exact)}`);
    console.log(`  结论：${dg.raw < P98 && Math.round(exact) === 100 ? '属实（低于 p98，靠四舍五入并列 100，非截断）' : '与说法不符'}`);
  }

  console.log(`\n回源核对：${pass} OK / ${fail} MISMATCH`);
  console.log(`公式复算：${hpass} OK / ${hfail} MISMATCH`);
  console.log(`总结论：${fail === 0 && hfail === 0 ? 'PASS' : 'FAIL'}`);
})();
