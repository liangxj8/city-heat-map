/* eslint-disable no-console */
'use strict';
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PAGE_URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\152.0.4191.62\\msedge.exe';

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  await page.goto(PAGE_URL, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  const info = await page.evaluate(() => {
    const chart = window.echarts.getInstanceByDom(document.getElementById('map'));
    const opt = chart.getOption();
    const regions = opt.geo[0].regions || [];
    const names = regions.map((r) => r.name + '|' + (r.itemStyle && r.itemStyle.areaColor));

    // 南海诸岛 dash 线采样点 -> 像素
    const nf = window.CHINA_GEO.features.find((f) => f.properties.name === '南海诸岛');
    const samples = [];
    if (nf) {
      nf.geometry.coordinates.forEach((poly) => {
        poly.forEach((ring) => {
          ring.forEach((pt) => { samples.push(pt); });
        });
      });
    }
    const c = document.querySelector('#map canvas');
    const ctx = c.getContext('2d');
    const box = document.getElementById('map').getBoundingClientRect();

    function sampleAt(lng, lat) {
      const p = chart.convertToPixel({ geoIndex: 0 }, [lng, lat]);
      if (!p || !isFinite(p[0])) { return null; }
      const x = Math.round(p[0]);
      const y = Math.round(p[1]);
      if (x < 0 || y < 0 || x >= c.width || y >= c.height) {
        return { lng, lat, x, y, offscreen: true };
      }
      // 在 5px 半径内找非底色像素
      const d = ctx.getImageData(Math.max(0, x - 5), Math.max(0, y - 5), 11, 11).data;
      let painted = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 0 && !(d[i] === 238 && d[i + 1] === 241 && d[i + 2] === 247)) { painted += 1; }
      }
      return { lng, lat, x: x + box.left, y: y + box.top, painted };
    }

    const checks = samples.slice(0, 400).map((pt) => sampleAt(pt[0], pt[1])).filter(Boolean);
    const onscreen = checks.filter((s) => !s.offscreen);

    // 全国范围像素包围盒
    const corners = [[73, 3.5], [135, 3.5], [73, 53.6], [135, 53.6], [104, 3.5], [112, 4]]
      .map((pt) => sampleAt(pt[0], pt[1]));

    return {
      regionCount: regions.length,
      regionSample: names.slice(0, 40),
      nanhaiSampleCount: samples.length,
      onscreenCount: onscreen.length,
      paintedOnscreen: onscreen.filter((s) => s.painted > 0).length,
      paintedTotal: checks.filter((s) => s.painted > 0).length,
      offscreenList: checks.filter((s) => s.offscreen).slice(0, 5),
      corners
    };
  });

  console.log(JSON.stringify(info, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
