/* eslint-disable no-console */
/**
 * 数据源可行性探测：百度迁徙（百度地图慧眼）全国城市迁入规模指数。
 * 目的：确认国庆假期 7 天数据是否齐全、能覆盖多少城市、值域分布如何。
 * 用法：node tools/probe-baidu-migration.js
 */
'use strict';

const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function get(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    const req = mod.get(url, { headers: { 'User-Agent': UA, Referer: 'https://qianxi.baidu.com/' } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('timeout')); });
  });
}

/** 百度返回的是 jsonp：cb({...})，剥壳后取 JSON。 */
function parseJsonp(text) {
  const s = text.indexOf('(');
  const e = text.lastIndexOf(')');
  if (s < 0 || e < 0) { return null; }
  try {
    return JSON.parse(text.slice(s + 1, e));
  } catch (err) {
    return null;
  }
}

async function fetchCityRank(date) {
  const url = `https://huiyan.baidu.com/migration/cityrank.jsonp?dt=country&type=move_in&date=${date}`;
  const text = await get(url);
  const json = parseJsonp(text);
  if (!json || json.errno !== 0 || !json.data || !json.data.list) {
    return { date, ok: false, count: 0, list: [] };
  }
  return { date, ok: true, count: json.data.list.length, list: json.data.list };
}

(async () => {
  const dates = ['20251001', '20251002', '20251003', '20251004', '20251005', '20251006', '20251007'];
  const byCity = new Map();
  const perDay = [];

  for (const d of dates) {
    let r;
    try {
      r = await fetchCityRank(d);
    } catch (err) {
      r = { date: d, ok: false, count: 0, list: [], err: err.message };
    }
    perDay.push({ date: d, ok: r.ok, count: r.count });
    if (r.ok) {
      r.list.forEach((it) => {
        if (!byCity.has(it.city_name)) { byCity.set(it.city_name, { province: it.province_name, values: [] }); }
        byCity.get(it.city_name).values.push(it.value);
      });
    }
    // 控频，避免被限流
    await new Promise((res) => setTimeout(res, 700));
  }

  console.log('\n===== 百度迁徙数据源探测 =====');
  console.log('日期\t可用\t城市数');
  perDay.forEach((p) => console.log(`${p.date}\t${p.ok ? 'OK' : 'FAIL'}\t${p.count}`));

  console.log(`\n去重后城市总数：${byCity.size}`);

  const all = [...byCity.entries()].map(([name, v]) => {
    const avg = v.values.reduce((a, b) => a + b, 0) / v.values.length;
    return { name, province: v.province, avg, days: v.values.length };
  }).sort((a, b) => b.avg - a.avg);

  const full = all.filter((c) => c.days === dates.length);
  console.log(`7 天数据齐全的城市：${full.length}`);

  console.log('\nTOP 15（日均迁入规模指数，单位：% 占全国）');
  all.slice(0, 15).forEach((c, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${c.name}\t${c.province}\t${c.avg.toFixed(3)}\t(${c.days}天)`);
  });
  console.log('\nBOTTOM 15');
  all.slice(-15).forEach((c) => {
    console.log(`      ${c.name}\t${c.province}\t${c.avg.toFixed(3)}\t(${c.days}天)`);
  });

  const vals = all.map((c) => c.avg);
  console.log(`\n值域：min=${Math.min(...vals).toFixed(4)} max=${Math.max(...vals).toFixed(4)}`);
  const provinces = new Set(all.map((c) => c.province));
  console.log(`省级覆盖：${provinces.size} 个 -> ${[...provinces].join('、')}`);
})();
