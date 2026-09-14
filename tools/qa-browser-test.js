/* eslint-disable no-console */
/**
 * QA 浏览器端渲染 + 交互验证（Round 1）
 * 用法：node tools/qa-browser-test.js
 * 通过 file:// 加载，验证「双击直接打开」这一硬约束。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PAGE_URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');

/**
 * 定位 Edge 可执行文件。
 * 原先硬编码 152.0.4191.62，Edge 自动升级后目录名变化即 MODULE/EXEC 找不到，
 * 改为在 Application 目录下自动挑选最新的「版本号目录」，避免每次升级都要改脚本。
 */
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
const SHOT_DIR = path.join(ROOT, 'qa-shots');

const results = [];
const consoleErrors = [];

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? '  [PASS]' : '  [FAIL]'} ${name}${detail ? ' —— ' + detail : ''}`);
}

/** 读取当前筛选后的城市数量与图表散点数。 */
async function snap(page) {
  return page.evaluate(() => {
    const chart = window.echarts.getInstanceByDom(document.getElementById('map'));
    const opt = chart.getOption();
    const statText = (document.querySelector('#top-stats .stat-v') || {}).textContent || '';
    // 三峡专题点位是独立的 series（id 'sanxiaScatter'），常规城市在 'cityScatter'，
    // 选中高亮是 effectScatter（不计入）。散点总数 = 所有 scatter series 之和。
    const seriesCount = (opt.series || []).reduce((n, s) => (
      n + ((s.type === 'scatter' && s.data) ? s.data.length : 0)
    ), 0);
    return {
      seriesCount,
      statCount: parseInt(statText.replace(/[^\d]/g, ''), 10) || 0,
      rankCount: document.querySelectorAll('#rank-list .rank-item').length,
      zoom: opt.geo[0].zoom,
      center: opt.geo[0].center,
      legend: document.getElementById('map-legend').textContent.replace(/\s+/g, ' ').trim()
    };
  });
}

/** 找一个离任何城市散点都足够远的可点击省份内部点。 */
async function findEmptyGeoPoint(page) {
  return page.evaluate(() => {
    const chart = window.echarts.getInstanceByDom(document.getElementById('map'));
    const candidates = [[97, 42.3], [92, 34], [86, 43], [104, 42.5], [95, 44], [113, 34.5],
      [88, 31.5], [90, 38], [100, 38], [108, 38.5], [84, 45], [96, 40], [112, 40.5], [85, 35]];
    const cities = window.CITIES;
    let best = null;
    for (const pt of candidates) {
      const px = chart.convertToPixel({ geoIndex: 0 }, pt);
      if (!px) { continue; }
      let minDist = Infinity;
      cities.forEach((c) => {
        const p2 = chart.convertToPixel({ geoIndex: 0 }, [c.lng, c.lat]);
        const d = Math.hypot(px[0] - p2[0], px[1] - p2[1]);
        if (d < minDist) { minDist = d; }
      });
      if (!best || minDist > best.minDist) { best = { lng: pt[0], lat: pt[1], minDist }; }
    }
    // 阈值放宽到 18px：散点 symbol 半径约 6-14px，18px 外不会误触散点。
    return best && best.minDist > 18 ? best : null;
  });
}

/** 把经纬度换算成地图容器内的像素坐标。 */
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

  page.on('console', (m) => {
    if (m.type() === 'error') { consoleErrors.push('console.error: ' + m.text()); }
    if (m.type() === 'warning' && /Uncaught|Error/.test(m.text())) {
      consoleErrors.push('console.warn: ' + m.text());
    }
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => {
    // file:// 下不应有任何外部请求
    consoleErrors.push('requestfailed: ' + r.url().slice(0, 120));
  });

  console.log('\n===== QA 浏览器验证 =====');
  console.log('URL: ' + PAGE_URL);

  await page.goto(PAGE_URL, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  // ---------------------------------------------------- 1. 渲染
  const canvasInfo = await page.evaluate(() => {
    const c = document.querySelector('#map canvas');
    if (!c) { return { exists: false }; }
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let painted = 0;
    const total = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 0) { painted += 1; }
    }
    return { exists: true, w: c.width, h: c.height, paintedRatio: painted / total };
  });
  check('地图 canvas 已渲染', canvasInfo.exists, canvasInfo.exists ? `${canvasInfo.w}x${canvasInfo.h}` : '未找到 canvas');
  check('地图非空白（绘制像素占比）', canvasInfo.paintedRatio > 0.05,
    `绘制像素占比 ${(canvasInfo.paintedRatio * 100).toFixed(1)}%`);

  const base = await snap(page);
  check('散点数 = 全部城市数', base.seriesCount === 359, `series=${base.seriesCount}`);
  check('顶部统计数 = 359', base.statCount === 359, `stat=${base.statCount}`);
  check('排行榜 = 20 条', base.rankCount === 20, `rank=${base.rankCount}`);

  await page.screenshot({ path: path.join(SHOT_DIR, '01-initial.png') });

  // ---------------------------------------------------- 2. 轮廓完整性
  const outline = await page.evaluate(() => {
    const names = window.CHINA_GEO.features.map((f) => f.properties.name);
    return {
      total: names.length,
      taiwan: names.indexOf('台湾省') !== -1,
      hainan: names.indexOf('海南省') !== -1,
      nanhai: names.some((n) => n && n.indexOf('南海诸岛') !== -1),
      hk: names.indexOf('香港特别行政区') !== -1,
      macao: names.indexOf('澳门特别行政区') !== -1
    };
  });
  check('GeoJSON 含台湾省', outline.taiwan);
  check('GeoJSON 含海南省', outline.hainan);
  check('GeoJSON 含南海诸岛', outline.nanhai);
  check('GeoJSON 含香港/澳门', outline.hk && outline.macao);

  // 南海诸岛：取九段线实际坐标换算像素后采样（初始视图下位于画布中下部）
  const nanhaiPixels = await page.evaluate(() => {
    const chart = window.echarts.getInstanceByDom(document.getElementById('map'));
    const nf = window.CHINA_GEO.features.find((f) => f.properties.name === '南海诸岛');
    if (!nf) { return -1; }
    const c = document.querySelector('#map canvas');
    const ctx = c.getContext('2d');
    const pts = [];
    nf.geometry.coordinates.forEach((poly) => poly.forEach((ring) => ring.forEach((pt) => pts.push(pt))));
    let painted = 0;
    let checked = 0;
    for (let i = 0; i < pts.length; i += 7) {
      const p = chart.convertToPixel({ geoIndex: 0 }, pts[i]);
      const x = Math.round(p[0]);
      const y = Math.round(p[1]);
      if (x < 2 || y < 2 || x >= c.width - 2 || y >= c.height - 2) { continue; }
      checked += 1;
      const d = ctx.getImageData(Math.max(0, x - 3), Math.max(0, y - 3), 7, 7).data;
      for (let k = 0; k < d.length; k += 4) {
        if (d[k + 3] > 0 && !(d[k] === 238 && d[k + 1] === 241 && d[k + 2] === 247)) { painted += 1; break; }
      }
    }
    return checked ? painted / checked : -1;
  });
  check('南海诸岛（九段线）已绘制', nanhaiPixels > 0.6, `覆盖采样点 ${(nanhaiPixels * 100).toFixed(0)}%`);

  // ---------------------------------------------------- 3. 滚轮缩放
  const box = await page.locator('#map').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(800);
  const afterZoom = await snap(page);
  check('滚轮向上可放大', afterZoom.zoom > base.zoom, `zoom ${base.zoom} -> ${afterZoom.zoom}`);

  // 拖拽平移
  const centerBefore = afterZoom.center;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 120, cy - 60, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const afterPan = await snap(page);
  const moved = centerBefore && afterPan.center
    && (Math.abs(centerBefore[0] - afterPan.center[0]) > 0.01 || Math.abs(centerBefore[1] - afterPan.center[1]) > 0.01);
  check('拖拽可平移', moved, `center ${JSON.stringify(centerBefore)} -> ${JSON.stringify(afterPan.center)}`);

  // 缩放复位
  await page.click('#btn-zoom-reset');
  // 复位是带过渡动画的，必须等动画彻底结束再取像素坐标，否则坐标漂移会导致 hover/click 落空。
  await page.waitForTimeout(1800);
  const afterReset = await snap(page);
  check('缩放复位按钮生效', Math.abs(afterReset.zoom - 1.25) < 0.01, `zoom=${afterReset.zoom}`);

  // ---------------------------------------------------- 4. Hover tooltip
  // 散点密集区顶部点未必是指定城市，这里选一个与邻点像素距离最大的孤立城市来 hover。
  // 同时要求该点远离容器边缘：贴边的点（如漠河在地图最顶端）在缩放复位后极易偏移到容器外，
  // 导致 hover/click 落空。
  const hoverCity = await page.evaluate(() => {
    const chart = window.echarts.getInstanceByDom(document.getElementById('map'));
    const el = document.getElementById('map');
    const W = el.clientWidth;
    const H = el.clientHeight;
    const PAD = 80;
    const cities = window.CITIES;
    let best = null;
    let bestMin = -1;
    cities.forEach((c) => {
      const p = chart.convertToPixel({ geoIndex: 0 }, [c.lng, c.lat]);
      if (!p) { return; }
      if (p[0] < PAD || p[0] > W - PAD || p[1] < PAD || p[1] > H - PAD) { return; }
      let min = Infinity;
      cities.forEach((o) => {
        if (o.name === c.name) { return; }
        const p2 = chart.convertToPixel({ geoIndex: 0 }, [o.lng, o.lat]);
        const d = Math.hypot(p[0] - p2[0], p[1] - p2[1]);
        if (d < min) { min = d; }
      });
      // 三峡专题点位的 tooltip 是官方数据格式（不含热度指数），
      // 不作为本用例的 hover/点击目标，但仍参与上面的邻近距离计算。
      if (c.src === 'official') { return; }
      if (min > bestMin) { bestMin = min; best = { name: c.name, x: p[0], y: p[1], min }; }
    });
    const box = el.getBoundingClientRect();
    return best
      ? { name: best.name, x: box.left + best.x, y: box.top + best.y, gap: bestMin, W, H }
      : null;
  });
  // 兜底：未找到孤立城市时也要让后续断言正常失败，而不是抛异常中断整个脚本。
  const hp = hoverCity || { name: '__none__', x: -100, y: -100, gap: 0 };
  check('可定位到用于 hover 的孤立城市', !!hoverCity,
    hoverCity ? `${hp.name} @(${hp.x.toFixed(0)},${hp.y.toFixed(0)}) 最近邻 ${hp.gap.toFixed(0)}px` : '未找到');

  // 先把指针移出地图并显式隐藏 tooltip：ECharts 隐藏时只置 visibility/opacity，
  // DOM 节点仍保留（offsetParent 依然非 null），会被选择器误当成当前 tooltip。
  await page.mouse.move(8, 8);
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const chart = window.echarts.getInstanceByDom(document.getElementById('map'));
    chart.dispatchAction({ type: 'hideTip' });
  });
  await page.waitForTimeout(300);
  await page.mouse.move(hp.x, hp.y);
  await page.waitForTimeout(1000);
  const tip = await page.evaluate(() => {
    // 取全局最后一个「真正可见」的 .tt（formatter 生成的根节点），排除历史残留节点。
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
  const tipCity = await page.evaluate((n) => {
    const c = window.CITIES.find((x) => x.name === n);
    return c ? { name: c.name, heat: c.heat, crowd: c.crowd, reason: c.reason } : null;
  }, hp.name);
  check('hover 散点出现 tooltip', !!tip, tip ? tip.slice(0, 60) : '未捕获 tooltip');
  if (tip && tipCity) {
    check('tooltip 城市名正确', tip.indexOf(tipCity.name) !== -1, `期望含「${tipCity.name}」`);
    check('tooltip 热度数值正确', tip.indexOf(tipCity.heat + ' / 100') !== -1, `期望含「${tipCity.heat} / 100」`);
    check('tooltip 含拥挤等级', tip.indexOf(tipCity.crowd) !== -1, tipCity.crowd);
    check('tooltip 含理由文案', tip.indexOf(tipCity.reason.slice(0, 8)) !== -1, tipCity.reason.slice(0, 12));
  }
  await page.screenshot({ path: path.join(SHOT_DIR, '02-tooltip.png') });

  // ---------------------------------------------------- 5. 点击散点 -> 详情
  // 点击前先销毁 tooltip，防止浮层拦截指针事件导致散点收不到 click。
  await page.mouse.move(8, 8);
  await page.waitForTimeout(500);
  await page.mouse.move(hp.x, hp.y);
  await page.waitForTimeout(120);
  await page.mouse.click(hp.x, hp.y);
  await page.waitForTimeout(900);
  const detail = await page.evaluate(() => {
    const d = document.getElementById('detail');
    const name = d.querySelector('.detail-name');
    return {
      name: name ? name.textContent.trim() : null,
      text: d.textContent.replace(/\s+/g, ' ').trim(),
      hasLocate: !!document.getElementById('btn-locate'),
      hasProvinceBtn: !!document.getElementById('btn-only-province'),
      hasSpots: d.querySelectorAll('.tag-spot').length
    };
  });
  check('点击散点后详情面板更新', detail.name === hp.name, `name=${detail.name} 期望=${hp.name}`);
  check('详情含代表景点', detail.hasSpots >= 2, `${detail.hasSpots} 个`);
  check('详情含「地图定位」按钮', detail.hasLocate);
  check('详情含「只看X省」按钮', detail.hasProvinceBtn);
  await page.screenshot({ path: path.join(SHOT_DIR, '03-detail.png') });

  // ---------------------------------------------------- 6. 省份下拉筛选
  await page.click('#btn-zoom-reset');
  await page.selectOption('#province-select', '浙江');
  await page.waitForTimeout(900);
  const zj = await snap(page);
  const zjCount = await page.evaluate(() => window.CITIES.filter((c) => c.province === '浙江').length);
  check('省份筛选：浙江', zj.seriesCount === zjCount && zj.statCount === zjCount,
    `series=${zj.seriesCount} stat=${zj.statCount} 期望=${zjCount}`);
  check('省份筛选后地图同步（散点数变化）', zj.seriesCount < 359, `${zj.seriesCount} < 359`);
  await page.screenshot({ path: path.join(SHOT_DIR, '04-province-zhejiang.png') });

  await page.selectOption('#province-select', 'all');
  await page.waitForTimeout(800);

  // ---------------------------------------------------- 7. 热度滑块
  await page.evaluate(() => {
    const el = document.getElementById('heat-min');
    el.value = '85';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(800);
  const hotOnly = await snap(page);
  const expectHot = await page.evaluate(() => window.CITIES.filter((c) => c.heat >= 85).length);
  check('热度区间 85-100 筛选', hotOnly.seriesCount === expectHot && hotOnly.statCount === expectHot,
    `series=${hotOnly.seriesCount} stat=${hotOnly.statCount} 期望=${expectHot}`);
  const sliderLabel = await page.textContent('#heat-val');
  check('滑块数值标签同步', sliderLabel.trim() === '85 - 100', `实际 "${sliderLabel.trim()}"`);

  // 预设档位 chip
  await page.click('#preset-row .chip[data-min="0"][data-max="29"]');
  await page.waitForTimeout(800);
  const cool = await snap(page);
  const expectCool = await page.evaluate(() => window.CITIES.filter((c) => c.heat < 30).length);
  check('预设档位「冷清 <30」生效', cool.seriesCount === expectCool, `series=${cool.seriesCount} 期望=${expectCool}`);

  await page.click('#btn-reset-filter');
  await page.waitForTimeout(800);
  const afterResetFilter = await snap(page);
  check('重置全部筛选生效', afterResetFilter.seriesCount === 359, `series=${afterResetFilter.seriesCount}`);

  // ---------------------------------------------------- 8. 快捷标签
  const quickLabels = await page.$$eval('#quick-row .chip', (els) => els.map((e) => e.textContent.trim()));
  check('快捷标签已渲染（8 个）', quickLabels.length === 8, quickLabels.join(' / '));

  await page.click('#quick-row .chip[data-key="quiet"]');
  await page.waitForTimeout(800);
  const quiet = await snap(page);
  const expectQuiet = await page.evaluate(() => window.CITIES.filter((c) => c.heat < 50).length);
  check('快捷筛选「只看人少的」生效', quiet.seriesCount === expectQuiet, `series=${quiet.seriesCount} 期望=${expectQuiet}`);

  await page.click('#quick-row .chip[data-key="crowded"]');
  await page.waitForTimeout(800);
  const crowded = await snap(page);
  const expectCrowded = await page.evaluate(() => window.CITIES.filter((c) => c.heat >= 85).length);
  check('快捷筛选「爆满预警」生效', crowded.seriesCount === expectCrowded, `series=${crowded.seriesCount} 期望=${expectCrowded}`);

  await page.click('#quick-row .chip[data-key="coast"]');
  await page.waitForTimeout(800);
  const coast = await snap(page);
  const expectCoast = await page.evaluate(() => window.CITIES.filter((c) => c.tags.indexOf('海滨海岛') !== -1).length);
  check('快捷筛选「海滨海岛」生效', coast.seriesCount === expectCoast, `series=${coast.seriesCount} 期望=${expectCoast}`);

  await page.click('#btn-reset-filter');
  await page.waitForTimeout(800);

  // ---------------------------------------------------- 9. 搜索
  await page.fill('#search-input', '丽江');
  await page.waitForTimeout(700);
  const suggestCount = await page.$$eval('#search-suggest .suggest-item', (els) => els.length);
  check('搜索联想出现候选', suggestCount >= 1, `${suggestCount} 条`);
  await page.press('#search-input', 'Enter');
  await page.waitForTimeout(1000);
  const searched = await page.evaluate(() => {
    const d = document.getElementById('detail');
    const n = d.querySelector('.detail-name');
    return { name: n ? n.textContent.trim() : null };
  });
  check('搜索回车定位到丽江', searched.name === '丽江', `detail=${searched.name}`);
  await page.screenshot({ path: path.join(SHOT_DIR, '05-search-lijiang.png') });

  await page.click('#btn-clear-search');
  await page.waitForTimeout(800);
  const cleared = await snap(page);
  check('清空搜索恢复全部', cleared.seriesCount === 359, `series=${cleared.seriesCount}`);

  // ---------------------------------------------------- 10. 排行榜
  const hotFirst = await page.$eval('#rank-list .rank-item', (e) => ({
    name: e.querySelector('.rank-name').textContent.trim(),
    heat: Number(e.querySelector('.rank-heat').textContent.trim())
  }));
  const maxHeat = await page.evaluate(() => Math.max.apply(null, window.CITIES.map((c) => c.heat)));
  check('最挤 TOP1 = 全国最高热度', hotFirst.heat === maxHeat, `${hotFirst.name} ${hotFirst.heat} / max ${maxHeat}`);

  await page.click('#rank-tabs .seg-btn[data-mode="cool"]');
  await page.waitForTimeout(800);
  const coolFirst = await page.$eval('#rank-list .rank-item', (e) => ({
    name: e.querySelector('.rank-name').textContent.trim(),
    heat: Number(e.querySelector('.rank-heat').textContent.trim())
  }));
  const minHeat = await page.evaluate(() => Math.min.apply(null, window.CITIES.map((c) => c.heat)));
  check('最舒服 TOP1 = 全国最低热度', coolFirst.heat === minHeat, `${coolFirst.name} ${coolFirst.heat} / min ${minHeat}`);

  // 点击排行榜条目 -> 定位 + 高亮（用 data-name 对齐，排名文案含省份后缀）
  const coolTarget = await page.$eval('#rank-list .rank-item', (e) => e.getAttribute('data-name'));
  await page.click('#rank-list .rank-item');
  await page.waitForTimeout(1200);
  const focused = await page.evaluate(() => {
    const chart = window.echarts.getInstanceByDom(document.getElementById('map'));
    const opt = chart.getOption();
    const hl = opt.series.find((s) => s.id === 'cityHighlight');
    const d = document.getElementById('detail');
    const n = d.querySelector('.detail-name');
    return {
      hlCount: hl ? hl.data.length : -1,
      hlName: hl && hl.data[0] ? hl.data[0].name : null,
      detailName: n ? n.textContent.trim() : null,
      zoom: opt.geo[0].zoom,
      activeRank: !!document.querySelector('#rank-list .rank-item.is-active')
    };
  });
  check('点击排行条目：详情同步', focused.detailName === coolTarget, `${focused.detailName} vs ${coolTarget}`);
  check('点击排行条目：高亮散点出现', focused.hlCount === 1 && focused.hlName === coolTarget,
    `hl=${focused.hlName}`);
  check('点击排行条目：地图放大定位', focused.zoom > 3, `zoom=${focused.zoom}`);
  check('点击排行条目：列表高亮', focused.activeRank);
  await page.screenshot({ path: path.join(SHOT_DIR, '06-rank-focus.png') });

  await page.click('#rank-tabs .seg-btn[data-mode="hot"]');
  await page.waitForTimeout(600);

  // ---------------------------------------------------- 11. 视图切换
  await page.click('#btn-zoom-reset');
  await page.waitForTimeout(600);
  await page.click('#view-switch .seg-btn[data-view="province"]');
  await page.waitForTimeout(1500);
  const provinceView = await page.evaluate(() => {
    const chart = window.echarts.getInstanceByDom(document.getElementById('map'));
    const opt = chart.getOption();
    const regions = opt.geo[0].regions || [];
    // ECharts 会为 GeoJSON 里每个 feature 自动补一个 region（含南海诸岛），校验以省份为口径
    const colored = regions.filter((r) => r.itemStyle && r.itemStyle.areaColor
      && r.itemStyle.areaColor !== '#eef1f7').length;
    return {
      regionNames: regions.map((r) => r.name),
      coloredCount: colored,
      title: document.getElementById('map-title').textContent.trim(),
      activeBtn: !!document.querySelector('#view-switch .seg-btn[data-view="province"].is-active')
    };
  });
  const provFull = await page.evaluate(() => Object.values({
    北京: '北京市', 天津: '天津市', 河北: '河北省', 山西: '山西省', 内蒙古: '内蒙古自治区',
    辽宁: '辽宁省', 吉林: '吉林省', 黑龙江: '黑龙江省', 上海: '上海市', 江苏: '江苏省',
    浙江: '浙江省', 安徽: '安徽省', 福建: '福建省', 江西: '江西省', 山东: '山东省',
    河南: '河南省', 湖北: '湖北省', 湖南: '湖南省', 广东: '广东省', 广西: '广西壮族自治区',
    海南: '海南省', 重庆: '重庆市', 四川: '四川省', 贵州: '贵州省', 云南: '云南省',
    西藏: '西藏自治区', 陕西: '陕西省', 甘肃: '甘肃省', 青海: '青海省', 宁夏: '宁夏回族自治区',
    新疆: '新疆维吾尔自治区', 台湾: '台湾省', 香港: '香港特别行政区', 澳门: '澳门特别行政区'
  }));
  check('省份填充视图：34 个省级均有着色', provinceView.coloredCount >= 34,
    `着色 region=${provinceView.coloredCount}（总 region=${provinceView.regionNames.length}，含自动补的南海诸岛）`);
  const missingProv = provFull.filter((n) => provinceView.regionNames.indexOf(n) === -1);
  check('省份填充视图：无省份缺失', missingProv.length === 0, missingProv.join(','));
  check('省份填充视图：标题切换', provinceView.title === '省份热度填充', provinceView.title);
  check('省份填充视图：按钮激活态', provinceView.activeBtn);
  await page.screenshot({ path: path.join(SHOT_DIR, '07-province-view.png') });

  // 省份填充视图下点击省份空白区域（避开所有散点）
  const emptyPt = await findEmptyGeoPoint(page);
  check('找到可点击的省份空白点', !!emptyPt, emptyPt ? `(${emptyPt.lng},${emptyPt.lat}) 最近散点 ${emptyPt.minDist.toFixed(0)}px` : '');
  if (emptyPt) {
    const gp = await toPixel(page, emptyPt.lng, emptyPt.lat);
    await page.mouse.click(gp.x, gp.y);
    await page.waitForTimeout(1200);
    const geoFilter = await page.evaluate(() => ({
      sel: document.getElementById('province-select').value,
      series: window.echarts.getInstanceByDom(document.getElementById('map')).getOption().series[0].data.length
    }));
    check('省份填充视图：点击省份可筛选', geoFilter.sel !== 'all',
      `select=${geoFilter.sel} series=${geoFilter.series}`);
    const provCount = await page.evaluate((p) => window.CITIES.filter((c) => c.province === p).length, geoFilter.sel);
    check('点击省份后散点数与该省一致', geoFilter.series === provCount, `${geoFilter.series} vs ${provCount}`);
  }

  await page.click('#view-switch .seg-btn[data-view="scatter"]');
  await page.waitForTimeout(1200);
  const backScatter = await page.evaluate(() => document.getElementById('map-title').textContent.trim());
  check('切换回城市气泡视图', backScatter === '城市热度气泡', backScatter);

  await page.click('#btn-reset-filter');
  await page.click('#btn-zoom-reset');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(SHOT_DIR, '08-final.png') });

  // ---------------------------------------------------- 12. 无外部网络请求
  const external = consoleErrors.filter((e) => e.indexOf('requestfailed') !== -1
    && (e.indexOf('http') !== -1));
  check('file:// 下无外部网络请求', external.length === 0, external.join(' | '));

  // ---------------------------------------------------- 报告
  const failed = results.filter((r) => !r.ok);
  console.log('\n================ 浏览器验证报告 ================');
  console.log(`通过 ${results.length - failed.length} / ${results.length}`);
  if (failed.length) {
    console.log('\n--- 失败项 ---');
    failed.forEach((f, i) => console.log(`  ${i + 1}. ${f.name} —— ${f.detail}`));
  }
  console.log('\n--- console 错误 / 页面异常 ---');
  if (consoleErrors.length === 0) { console.log('  （无）'); }
  consoleErrors.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));

  await browser.close();
  process.exit(failed.length === 0 && consoleErrors.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试脚本异常：', e);
  process.exit(2);
});
