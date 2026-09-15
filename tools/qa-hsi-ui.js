/* tools/qa-hsi-ui.js —— HSI 指标与四象限视图的浏览器自检
 * 运行：NODE_PATH=... node tools/qa-hsi-ui.js
 */
'use strict';
const path = require('path');
const fs = require('fs');

const PW = 'C:/Users/liangxj8/.workbuddy/binaries/node/workspace/node_modules/playwright-core';
const { chromium } = require(PW);

const FILE = 'file:///' + path.join(__dirname, '..', 'index.html').replace(/\\/g, '/');
const SHOT_DIR = path.join(__dirname, '..', 'qa-shots');

function resolveEdge() {
  const base = 'C:/Program Files (x86)/Microsoft/Edge/Application';
  const cands = [base + '/msedge.exe'];
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      if (/^\d+\./.test(d)) {
        const g = base + '/' + d + '/msedge.exe';
        if (fs.existsSync(g)) cands.push(g);
      }
    }
  }
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('Edge not found');
}

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}

(async () => {
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ executablePath: resolveEdge(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  console.log('=== HSI 前端自检 ===');

  /* 1. 数据加载 */
  const loaded = await page.evaluate(() => ({
    cities: (window.CITIES || []).length,
    hsi: window.HSI ? window.HSI.records.length : 0,
    primary: window.HSI ? window.HSI.primaryYear : null,
    rankable: window.HSI ? window.HSI.rankableYears : []
  }));
  ok('CITIES 已加载 359', loaded.cities === 359, String(loaded.cities));
  ok('HSI 已加载 75 条', loaded.hsi === 75, String(loaded.hsi));
  ok('主年份 = 2025', loaded.primary === 2025, String(loaded.primary));
  ok('可排名年份 = [2025, 2023]', JSON.stringify(loaded.rankable) === '[2025,2023]', JSON.stringify(loaded.rankable));

  /* 2. 初始视图（热度） */
  const init = await page.evaluate(() => ({
    title: document.getElementById('map-title').textContent,
    hint: document.getElementById('metric-hint').textContent,
    rank: document.querySelectorAll('#rank-list .rank-item').length,
    legend: document.getElementById('map-legend').textContent.indexOf('爆满') >= 0
  }));
  ok('初始标题 = 城市热度气泡', init.title === '城市热度气泡', init.title);
  ok('初始榜单有 20 条', init.rank === 20, String(init.rank));
  ok('初始图例含「爆满」', init.legend);
  await page.screenshot({ path: path.join(SHOT_DIR, 'hsi-01-heat.png') });

  /* 3. 切到住宿紧张度 */
  await page.click('#metric-switch .seg-btn[data-metric="hsi"]');
  await page.waitForTimeout(1200);
  const hsiView = await page.evaluate(() => {
    const opt = window.__chart ? null : null;
    return {
      title: document.getElementById('map-title').textContent,
      hint: document.getElementById('metric-hint').textContent,
      rank: document.querySelectorAll('#rank-list .rank-item').length,
      legendText: document.getElementById('map-legend').textContent,
      firstRank: (document.querySelector('#rank-list .rank-item .rank-name') || {}).textContent,
      note: !!document.querySelector('#rank-list .rank-note')
    };
  });
  ok('切到 HSI 后标题 = 住宿紧张度气泡', hsiView.title === '住宿紧张度气泡', hsiView.title);
  ok('HSI 提示文案已更新', hsiView.hint.indexOf('住宿有多紧张') >= 0, hsiView.hint);
  ok('HSI 榜单有条目', hsiView.rank > 0, hsiView.rank + ' 条');
  ok('HSI 图例含「一房难求」', hsiView.legendText.indexOf('一房难求') >= 0);
  ok('HSI 图例含口径说明', hsiView.legendText.indexOf('供需紧张程度') >= 0);
  ok('HSI 榜单带口径提示行', hsiView.note);
  console.log('  INFO  HSI 榜首 = ' + (hsiView.firstRank || '').trim());
  await page.screenshot({ path: path.join(SHOT_DIR, 'hsi-02-hsi.png') });

  /* 4. 点开一个有 HSI 的城市看详情 */
  await page.click('#rank-list .rank-item');
  await page.waitForTimeout(900);
  const detail = await page.evaluate(() => document.getElementById('detail').textContent);
  ok('详情出现「住宿紧张度 HSI」区块', detail.indexOf('住宿紧张度 HSI') >= 0);
  ok('详情含平日/假期价格', /平日 ¥\d+ → 假期 ¥\d+/.test(detail));
  ok('详情含涨幅百分比', /涨幅 \d/.test(detail));
  await page.screenshot({ path: path.join(SHOT_DIR, 'hsi-03-detail.png') });

  /* 5. 四象限视图 */
  await page.click('#view-switch .seg-btn[data-view="quadrant"]');
  await page.waitForTimeout(1500);
  const quad = await page.evaluate(() => {
    const dom = document.querySelector('#map canvas');
    return {
      title: document.getElementById('map-title').textContent,
      hasCanvas: !!dom,
      metricBtns: document.querySelectorAll('#metric-switch .seg-btn.is-active').length
    };
  });
  ok('四象限标题正确', quad.title === '量价四象限', quad.title);
  ok('四象限画布已渲染', quad.hasCanvas);
  ok('四象限下两个指标按钮都高亮', quad.metricBtns === 2, quad.metricBtns + ' 个');
  await page.screenshot({ path: path.join(SHOT_DIR, 'hsi-04-quadrant.png') });

  /* 6. 四象限里的散点数（从 ECharts 实例读） */
  const quadData = await page.evaluate(() => {
    // 通过 DOM 上的 echarts 实例拿 option
    const holder = document.getElementById('map');
    const inst = window.echarts ? window.echarts.getInstanceByDom(holder) : null;
    if (!inst) return { ok: false };
    const opt = inst.getOption();
    const s = (opt.series || [])[0];
    return {
      ok: true,
      count: (s && s.data) ? s.data.length : 0,
      hasX: !!(opt.xAxis && opt.xAxis.length),
      hasY: !!(opt.yAxis && opt.yAxis.length),
      hasGeo: !!(opt.geo && opt.geo.length)
    };
  });
  ok('能取到 ECharts 实例', quadData.ok);
  ok('四象限散点数 > 30', quadData.count > 30, quadData.count + ' 个');
  ok('四象限使用直角坐标系（xAxis/yAxis）', quadData.hasX && quadData.hasY);
  ok('四象限未残留 geo 组件', !quadData.hasGeo);

  /* 7. 回到地图视图 */
  await page.click('#view-switch .seg-btn[data-view="scatter"]');
  await page.waitForTimeout(1200);
  const back = await page.evaluate(() => {
    const holder = document.getElementById('map');
    const inst = window.echarts.getInstanceByDom(holder);
    const opt = inst.getOption();
    return { hasGeo: !!(opt.geo && opt.geo.length), series: (opt.series || []).length };
  });
  ok('切回地图后 geo 恢复', back.hasGeo);
  ok('切回地图后 series 正常', back.series >= 3, back.series + ' 个');

  /* 8. 无 JS 报错 */
  ok('无 console / page 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('运行异常：', e.message);
  process.exit(1);
});
