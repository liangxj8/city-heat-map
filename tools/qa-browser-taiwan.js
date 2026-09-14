/* eslint-disable no-console */
/**
 * QA：台湾省「省级汇总口径」城市 + 港澳的边界行为 —— 真实浏览器验证。
 *
 * 与 tools/qa-rank-provincesrc.js（vm 沙箱）互补：那一支只验证纯函数输出，
 * 本支在真实 Edge + file:// 下验证 DOM 真实渲染出来的结果，
 * 覆盖榜单、tooltip、详情面板、统计卡、地图散点。
 *
 * 用法：
 *   NODE_PATH=<_qa-env>/node_modules node tools/qa-browser-taiwan.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PAGE_URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');

/** 定位 Edge（同 qa-browser-test.js 的自动探测逻辑，避免硬编码版本号）。 */
function resolveEdge() {
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
        const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          if ((pb[i] || 0) !== (pa[i] || 0)) { return (pb[i] || 0) - (pa[i] || 0); }
        }
        return 0;
      });
      return path.join(base, versions[0], 'msedge.exe');
    }
  }
  return null;
}

const EDGE = process.env.QA_EDGE_PATH || resolveEdge();
if (!EDGE) {
  console.error('未找到 Edge 可执行文件，请设置环境变量 QA_EDGE_PATH 指向 msedge.exe');
  process.exit(1);
}

const results = [];
/**
 * 记录一条断言结果。
 * @param {string} name 断言名称。
 * @param {boolean} ok 是否通过。
 * @param {string} detail 详情。
 * @returns {void}
 */
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? '  [PASS]' : '  [FAIL]'} ${name}${detail ? ' —— ' + detail : ''}`);
}

// 省级汇总口径（台湾 6 市）——与 cities.js 中 src='province' 的集合保持一致
const TAIWAN = ['台北', '高雄', '台中', '台南', '花莲', '垦丁'];
const NOTE_KEY = '与大陆城市不完全可比';

/**
 * hover 指定城市并读取「当前真正可见」的 tooltip 文本。
 * 不能读 document.body.innerText：详情面板里残留的口径文案会污染判定。
 * ECharts 隐藏 tooltip 时只置 visibility/opacity，DOM 节点仍在，
 * 因此必须先 hideTip + 移开指针，再取最后一个可见的 .tt 节点。
 */
async function hoverAndReadTooltip(page, name) {
  const pos = await page.evaluate((n) => {
    const c = window.CITIES.find((x) => x.name === n);
    const chart = window.echarts.getInstanceByDom(document.getElementById('map'));
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
  await page.waitForTimeout(300);
  await page.mouse.move(pos.x, pos.y);
  await page.waitForTimeout(1000);

  return page.evaluate(() => {
    const all = Array.prototype.slice.call(document.querySelectorAll('div'));
    const visible = all.filter((d) => {
      if (d.className !== 'tt') { return false; }
      const cs = getComputedStyle(d);
      if (cs.visibility === 'hidden' || cs.display === 'none') { return false; }
      if (parseFloat(cs.opacity) === 0) { return false; }
      const r = d.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const node = visible[visible.length - 1];
    return node ? node.textContent.replace(/\s+/g, ' ').trim() : null;
  });
}

/** 经纬度 -> 页面像素坐标。 */
async function toPixel(page, lng, lat) {
  return page.evaluate(([lo, la]) => {
    const chart = window.echarts.getInstanceByDom(document.getElementById('map'));
    const p = chart.convertToPixel({ geoIndex: 0 }, [lo, la]);
    const box = document.getElementById('map').getBoundingClientRect();
    return { x: box.left + p[0], y: box.top + p[1] };
  }, [lng, lat]);
}

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(PAGE_URL, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  console.log('\n===== 台湾省 / 港澳 边界行为（真实浏览器） =====');

  // ---------------------------------------------- 1. 全国「最舒服 TOP20」
  await page.click('#rank-tabs button[data-mode="cool"]');
  await page.waitForTimeout(400);
  const cool = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#rank-list .rank-item')];
    return {
      count: items.length,
      names: items.map((li) => li.getAttribute('data-name')),
      hasNote: !!document.querySelector('#rank-list .rank-note')
    };
  });
  check('全国「最舒服 TOP20」条数 = 20', cool.count === 20, `实际 ${cool.count} 条`);
  const leaked = cool.names.filter((n) => TAIWAN.indexOf(n) !== -1);
  check('全国「最舒服 TOP20」不含台湾城市', leaked.length === 0,
    leaked.length ? `混入：${leaked.join('、')}` : `前5：${cool.names.slice(0, 5).join('、')}`);
  check('全国榜单无口径提示', !cool.hasNote);
  check('最舒服榜首为真实低热度城市（三沙）', cool.names[0] === '三沙', `实际 ${cool.names[0]}`);

  // ---------------------------------------------- 2. 全国「最挤 TOP20」
  await page.click('#rank-tabs button[data-mode="hot"]');
  await page.waitForTimeout(400);
  const hot = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#rank-list .rank-item')];
    return items.map((li) => li.getAttribute('data-name'));
  });
  const hotLeak = hot.filter((n) => TAIWAN.indexOf(n) !== -1);
  check('全国「最挤 TOP20」不含台湾城市', hotLeak.length === 0,
    hotLeak.length ? `混入：${hotLeak.join('、')}` : `前5：${hot.slice(0, 5).join('、')}`);

  // ---------------------------------------------- 3. 台湾省筛选 -> 榜单回退 6 条
  await page.selectOption('#province-select', '台湾');
  await page.waitForTimeout(600);
  const tw = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#rank-list .rank-item')];
    const note = document.querySelector('#rank-list .rank-note');
    return {
      count: items.length,
      names: items.map((li) => li.getAttribute('data-name')),
      note: note ? note.textContent.trim() : ''
    };
  });
  check('台湾省筛选：榜单显示 6 条（不空白）', tw.count === 6, `实际 ${tw.count} 条：${tw.names.join('、')}`);
  check('台湾省筛选：6 市齐全', TAIWAN.every((n) => tw.names.indexOf(n) !== -1), tw.names.join('、'));
  check('台湾省筛选：显示口径提示', tw.note.indexOf(NOTE_KEY) !== -1, tw.note.slice(0, 40));

  // 台湾省筛选下散点数
  const twSeries = await page.evaluate(() => window.CITIES.filter((c) => c.province === '台湾').length);
  check('台湾省共 6 个城市数据点', twSeries === 6, `实际 ${twSeries}`);

  // ---------------------------------------------- 4. 台湾城市散点可 hover / 点击
  await page.selectOption('#province-select', 'all');
  await page.waitForTimeout(600);

  const tpInfo = await page.evaluate(() => {
    const c = window.CITIES.find((x) => x.name === '台北');
    return { heat: c.heat, src: c.src };
  });
  const tpTip = await hoverAndReadTooltip(page, '台北');
  check('台湾城市（台北）hover 出 tooltip', !!tpTip && tpTip.indexOf('台北') !== -1,
    `src=${tpInfo.src} heat=${tpInfo.heat}`);
  check('台湾城市 tooltip 含口径说明', !!tpTip && tpTip.indexOf(NOTE_KEY) !== -1,
    tpTip ? tpTip.slice(0, 50) : '未捕获 tooltip');

  const tpPos = await toPixel(page, ...(await page.evaluate(() => {
    const c = window.CITIES.find((x) => x.name === '台北');
    return [c.lng, c.lat];
  })));
  await page.mouse.click(tpPos.x, tpPos.y);
  await page.waitForTimeout(700);
  const tpDetail = await page.evaluate(() => document.getElementById('detail').innerText);
  check('台湾城市可点击查看详情', tpDetail.indexOf('台北') !== -1);
  check('台湾城市详情含口径说明', tpDetail.indexOf(NOTE_KEY) !== -1);

  // ---------------------------------------------- 5. 香港 / 澳门不被误伤
  const hkTip = await hoverAndReadTooltip(page, '香港');
  check('香港 hover 出 tooltip', !!hkTip && hkTip.indexOf('香港') !== -1, hkTip ? hkTip.slice(0, 50) : '未捕获');
  check('香港 tooltip 无误加口径标注', !!hkTip && hkTip.indexOf(NOTE_KEY) === -1, '香港为 real 市级数据');

  const hkPos = await toPixel(page, ...(await page.evaluate(() => {
    const c = window.CITIES.find((x) => x.name === '香港');
    return [c.lng, c.lat];
  })));
  await page.mouse.click(hkPos.x, hkPos.y);
  await page.waitForTimeout(700);
  const hkDetail = await page.evaluate(() => document.getElementById('detail').innerText);
  check('香港详情无误加口径标注', hkDetail.indexOf(NOTE_KEY) === -1);

  const moTip = await hoverAndReadTooltip(page, '澳门');
  check('澳门 hover 出 tooltip', !!moTip && moTip.indexOf('澳门') !== -1, moTip ? moTip.slice(0, 50) : '未捕获');
  check('澳门 tooltip 无误加口径标注', !!moTip && moTip.indexOf(NOTE_KEY) === -1, '澳门为 real 市级数据');

  // 香港参与排名：省份筛选香港 -> 榜单 1 条
  await page.selectOption('#province-select', '香港');
  await page.waitForTimeout(600);
  const hkRank = await page.evaluate(() => [...document.querySelectorAll('#rank-list .rank-item')]
    .map((li) => li.getAttribute('data-name')));
  check('香港正常参与排名', hkRank.length === 1 && hkRank[0] === '香港', `榜单：${hkRank.join('、')}`);

  await page.selectOption('#province-select', '澳门');
  await page.waitForTimeout(600);
  const moRank = await page.evaluate(() => [...document.querySelectorAll('#rank-list .rank-item')]
    .map((li) => li.getAttribute('data-name')));
  check('澳门正常参与排名', moRank.length === 1 && moRank[0] === '澳门', `榜单：${moRank.join('、')}`);

  // ---------------------------------------------- 6. 顶部统计卡为真实极值
  await page.selectOption('#province-select', 'all');
  await page.waitForTimeout(600);
  const stats = await page.evaluate(() => {
    const t = document.getElementById('top-stats').innerText;
    const all = window.CITIES.filter((c) => c.src !== 'province');
    const max = Math.max(...all.map((c) => c.heat));
    const min = Math.min(...all.map((c) => c.heat));
    return { text: t, max, min, hottest: all.filter((c) => c.heat === max).map((c) => c.name), coolest: all.filter((c) => c.heat === min).map((c) => c.name) };
  });
  const statHasTW = TAIWAN.some((n) => stats.text.indexOf(n) !== -1);
  check('顶部统计卡不出现台湾城市', !statHasTW, `统计卡：${stats.text.replace(/\n/g, ' ').slice(0, 60)}`);
  check('顶部统计卡最挤为真实极值(heat=100)',
    stats.hottest.some((n) => stats.text.indexOf(n) !== -1),
    `极值城市：${stats.hottest.join('/')}`);
  check('顶部统计卡最舒服为真实极值(heat=0)',
    stats.coolest.some((n) => stats.text.indexOf(n) !== -1),
    `极值城市：${stats.coolest.join('/')}`);

  // ---------------------------------------------- 7. 台湾散点在地图系列中
  const inSeries = await page.evaluate((taiwanNames) => {
    const chart = window.echarts.getInstanceByDom(document.getElementById('map'));
    const opt = chart.getOption();
    const data = opt.series.find((s) => s.type === 'scatter').data;
    return {
      total: data.length,
      taiwan: data.filter((d) => d && taiwanNames.indexOf(d.name) !== -1).map((d) => d.name)
    };
  }, TAIWAN).catch(() => null);
  if (inSeries) {
    check('地图散点含全部 6 个台湾城市', inSeries.taiwan.length === 6,
      `${inSeries.taiwan.join('、')}（总散点 ${inSeries.total}）`);
  }

  check('无 JS 运行时异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  const passed = results.filter((r) => r.ok).length;
  console.log('\n================ 台湾/港澳边界行为报告 ================');
  console.log(`通过 ${passed} / ${results.length}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('\n--- 失败明细 ---');
    failed.forEach((f, i) => console.log(`  ${i + 1}. ${f.name} —— ${f.detail}`));
  }
  await browser.close();
  process.exit(failed.length === 0 ? 0 : 1);
})();
