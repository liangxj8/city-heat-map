/* eslint-disable no-console */
/**
 * 三峡专题点位（奉节 / 巫山 / 巴东 / 秭归）浏览器验证。
 * 验证点：
 *   1. 四个县都在地图上、且用专题色渲染（独立 series）
 *   2. hover / 点击展示的是官方真实数据，而非不可比的热度指数
 *   3. 明确标注统计口径与不可比提示
 *   4. 不参与全国热度榜单排名与统计卡极值
 *   5. 可搜索、可被省份筛选命中
 * 用法：NODE_PATH=<_qa-env/node_modules> node tools/qa-sanxia.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PAGE_URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');

/** 定位 Edge 可执行文件（与 qa-browser-test.js 同逻辑，避免版本升级后路径失效）。 */
function resolveEdge() {
  if (process.env.QA_EDGE_PATH) { return process.env.QA_EDGE_PATH; }
  const bases = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application',
    'C:\\Program Files\\Microsoft\\Edge\\Application'
  ];
  for (const base of bases) {
    if (!fs.existsSync(base)) { continue; }
    const direct = path.join(base, 'msedge.exe');
    if (fs.existsSync(direct)) { return direct; }
    const versions = fs.readdirSync(base)
      .filter((d) => /^\d+(\.\d+)*$/.test(d) && fs.existsSync(path.join(base, d, 'msedge.exe')));
    if (versions.length) {
      versions.sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
          if ((pb[i] || 0) !== (pa[i] || 0)) { return (pb[i] || 0) - (pa[i] || 0); }
        }
        return 0;
      });
      return path.join(base, versions[0], 'msedge.exe');
    }
  }
  return null;
}
const EDGE = resolveEdge();

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? '  [PASS]' : '  [FAIL]'} ${name}${detail ? ' —— ' + detail : ''}`);
}

/** 取当前真正可见的 tooltip 文本（排除 ECharts 隐藏残留节点）。 */
async function visibleTip(page) {
  return page.evaluate(() => {
    const all = Array.prototype.slice.call(document.querySelectorAll('div'));
    const vis = all.filter((d) => {
      if (d.className !== 'tt') { return false; }
      const cs = getComputedStyle(d);
      if (cs.visibility === 'hidden' || cs.display === 'none') { return false; }
      if (parseFloat(cs.opacity) === 0) { return false; }
      const r = d.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const n = vis[vis.length - 1];
    return n ? n.textContent.replace(/\s+/g, ' ').trim() : null;
  });
}

(async () => {
  console.log('\n===== 三峡专题点位验证 =====');
  console.log('URL: ' + PAGE_URL);

  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  await page.goto(PAGE_URL, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  // ---------- 1. 数据层 ----------
  const sanxia = await page.evaluate(() => (window.CITIES || []).filter((c) => c.src === 'official'));
  check('三峡专题点位共 4 个', sanxia.length === 4,
    sanxia.map((c) => c.name).join('、'));

  const fieldsOk = sanxia.every((c) => c.official
    && Number.isFinite(c.official.value) && c.official.unit
    && c.official.caliber && c.official.detail && c.official.source);
  check('官方数据字段完整（value/unit/caliber/detail/source）', fieldsOk);

  const expect = {
    奉节: { value: 22.73, caliber: '景区购票游客' },
    巫山: { value: 96.75, caliber: '全县接待游客（8 天）' },
    巴东: { value: 50.75, caliber: '全县接待游客' },
    秭归: { value: 13.56, caliber: 'A 级景区接待' }
  };
  let valueOk = true;
  let caliberOk = true;
  sanxia.forEach((c) => {
    const e = expect[c.name];
    if (!e || c.official.value !== e.value) { valueOk = false; }
    if (!e || c.official.caliber !== e.caliber) { caliberOk = false; }
  });
  check('四个县的官方数值与采集一致', valueOk,
    sanxia.map((c) => `${c.name} ${c.official.value}${c.official.unit}`).join('; '));
  check('四个县的统计口径标注正确', caliberOk,
    sanxia.map((c) => `${c.name}=${c.official.caliber}`).join('; '));

  // 数据文件中是否含外部 URL 由 qa-validate-data.js 断言（file:// 零外链），此处不重复。
  const noHeat = sanxia.every((c) => c.raw === null);
  check('三峡点位无迁徙原始指数（raw 为 null）', noHeat);

  // ---------- 2. 渲染成独立 series ----------
  const seriesInfo = await page.evaluate(() => {
    const chart = window.echarts.getInstanceByDom(document.getElementById('map'));
    const opt = chart.getOption();
    return (opt.series || []).map((s) => ({ id: s.id, type: s.type, n: (s.data || []).length }));
  });
  const san = seriesInfo.find((s) => s.id === 'sanxiaScatter');
  const main = seriesInfo.find((s) => s.id === 'cityScatter');
  check('三峡专题是独立 scatter series', !!san && san.n === 4,
    san ? `sanxiaScatter=${san.n}` : '未找到');
  check('常规城市 series 未混入专题点位', !!main && main.n === 355, `cityScatter=${main.n}`);

  // ---------- 3. hover 展示官方数据 ----------
  // 先把视野定位到重庆，确保四个县在可视区域内
  await page.selectOption('#province-select', '重庆');
  await page.waitForTimeout(1200);

  for (const name of ['奉节', '巫山']) {
    const pt = await page.evaluate((n) => {
      const chart = window.echarts.getInstanceByDom(document.getElementById('map'));
      const c = window.CITIES.find((x) => x.name === n);
      const p = chart.convertToPixel({ geoIndex: 0 }, [c.lng, c.lat]);
      const box = document.getElementById('map').getBoundingClientRect();
      return { x: box.left + p[0], y: box.top + p[1] };
    }, name);

    await page.mouse.move(8, 8);
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const chart = window.echarts.getInstanceByDom(document.getElementById('map'));
      chart.dispatchAction({ type: 'hideTip' });
    });
    await page.waitForTimeout(200);
    await page.mouse.move(pt.x, pt.y);
    await page.waitForTimeout(900);
    const tip = await visibleTip(page);

    const city = sanxia.find((c) => c.name === name);
    check(`${name} hover 出 tooltip`, !!tip, tip ? tip.slice(0, 46) : '未捕获');
    if (tip && city) {
      check(`  ${name} 显示官方接待量`, tip.indexOf(String(city.official.value)) !== -1,
        `期望含 ${city.official.value}`);
      check(`  ${name} 显示统计口径`, tip.indexOf(city.official.caliber) !== -1, city.official.caliber);
      check(`  ${name} 标记为三峡专题`, tip.indexOf('三峡专题') !== -1);
      check(`  ${name} 含不可比提示`, tip.indexOf('不可比') !== -1);
      check(`  ${name} 不显示热度指数`, !/国庆热度指数\s*\d+\s*\/\s*100/.test(tip));
    }
  }

  // ---------- 4. 点击详情 ----------
  const ptFj = await page.evaluate(() => {
    const chart = window.echarts.getInstanceByDom(document.getElementById('map'));
    const c = window.CITIES.find((x) => x.name === '奉节');
    const p = chart.convertToPixel({ geoIndex: 0 }, [c.lng, c.lat]);
    const box = document.getElementById('map').getBoundingClientRect();
    return { x: box.left + p[0], y: box.top + p[1] };
  });
  await page.mouse.move(8, 8);
  await page.waitForTimeout(400);
  await page.mouse.move(ptFj.x, ptFj.y);
  await page.waitForTimeout(150);
  await page.mouse.click(ptFj.x, ptFj.y);
  await page.waitForTimeout(900);
  const detail = await page.evaluate(() => {
    const d = document.getElementById('detail');
    const n = d.querySelector('.detail-name');
    return { name: n ? n.textContent.trim() : null, text: d.textContent.replace(/\s+/g, ' ').trim() };
  });
  check('点击奉节打开详情', detail.name === '奉节', `name=${detail.name}`);
  if (detail.name === '奉节') {
    check('  详情显示官方接待量数值', detail.text.indexOf('22.73') !== -1);
    check('  详情显示统计口径', detail.text.indexOf('景区购票游客') !== -1);
    check('  详情显示数据来源', detail.text.indexOf('奉节县人民政府') !== -1);
    check('  详情含官方数据明细', detail.text.indexOf('白帝城') !== -1);
    check('  详情含不可比提示', detail.text.indexOf('不可比') !== -1);
  }

  // ---------- 5. 不参与排名与统计 ----------
  await page.selectOption('#province-select', 'all');
  await page.waitForTimeout(1200);

  const rankNames = await page.$$eval('#rank-list .rank-item .rank-name',
    (els) => els.map((e) => e.textContent.trim()));
  const statText = await page.textContent('#top-stats');
  const inRank = rankNames.some((n) => ['奉节', '巫山', '巴东', '秭归'].indexOf(n) !== -1);
  check('三峡点位不出现在全国热度榜', !inRank, `榜单 ${rankNames.length} 条，前 5：${rankNames.slice(0, 5).join('/')}`);
  check('统计卡极值不是三峡点位',
    !/最挤\s*(奉节|巫山|巴东|秭归)/.test(statText.replace(/\s+/g, ''))
    && !/最舒服\s*(奉节|巫山|巴东|秭归)/.test(statText.replace(/\s+/g, '')),
    (statText || '').replace(/\s+/g, ' ').trim().slice(0, 60));

  // ---------- 6. 搜索可达 ----------
  await page.fill('#search-input', '秭归');
  await page.waitForTimeout(700);
  const sugCount = await page.$$eval('#suggest .suggest-item', (els) => els.length)
    .catch(() => 0);
  await page.press('#search-input', 'Enter');
  await page.waitForTimeout(900);
  const afterSearch = await page.evaluate(() => {
    const d = document.getElementById('detail');
    const n = d.querySelector('.detail-name');
    return n ? n.textContent.trim() : null;
  });
  check('搜索「秭归」可定位', afterSearch === '秭归', `detail=${afterSearch}（联想 ${sugCount} 条）`);

  await browser.close();

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n================ 三峡专题报告 ================`);
  console.log(`通过 ${pass} / ${results.length}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('\n--- 失败项 ---');
    failed.forEach((f, i) => console.log(`  ${i + 1}. ${f.name} —— ${f.detail}`));
  }
  process.exit(failed.length ? 1 : 0);
})();
