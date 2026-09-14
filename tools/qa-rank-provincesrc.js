/* eslint-disable no-console */
/**
 * QA：省级汇总口径（src === 'province'）城市的榜单排序行为验证。
 *
 * 目的：验证 renderRank() 的新规则——
 *   1. 存在其它城市时，province 口径城市不进「最挤 / 最舒服」榜单；
 *   2. 筛选结果里只剩这类城市时，榜单正常显示它们，并附口径提示；
 *   3. 香港、澳门（src === 'real'）正常参与排名，不被误伤；
 *   4. tooltip / 详情面板对这类城市输出口径标注；
 *   5. 地图散点数据源（getFilteredCities）不受影响，仍包含这类城市。
 *
 * 做法：把 assets/app.js 源码注入测试钩子后在 vm 沙箱中执行（不触发 init），
 *      用桩对象接管 DOM，直接调用内部函数并断言其输出。
 *
 * 用法：node tools/qa-rank-provincesrc.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const failures = [];
let passed = 0;

/**
 * 断言。
 * @param {boolean} cond 条件。
 * @param {string} msg 失败信息。
 * @returns {void}
 */
function assert(cond, msg) {
  if (cond) { passed += 1; } else { failures.push(msg); }
}

/** 创建一个最小 DOM 桩对象。 */
function makeElement() {
  return {
    innerHTML: '',
    textContent: '',
    value: '',
    classList: { toggle: function () {}, add: function () {}, remove: function () {} },
    setAttribute: function () {},
    getAttribute: function () { return null; },
    addEventListener: function () {},
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    appendChild: function () {}
  };
}

const sandboxDocument = {
  readyState: 'loading',
  addEventListener: function () {},
  createElement: makeElement,
  getElementById: function () { return makeElement(); },
  querySelector: function () { return null; },
  querySelectorAll: function () { return []; },
  body: makeElement()
};

const sandbox = {
  document: sandboxDocument,
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// 载入真实数据
vm.runInContext(fs.readFileSync(path.join(ROOT, 'data', 'cities.js'), 'utf8'), sandbox);
assert(Array.isArray(sandbox.CITIES) && sandbox.CITIES.length > 0, 'CITIES 未加载');

// 注入测试钩子（在 IIFE 结束前把内部函数暴露出来）
const appSrc = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');
const endMark = '})();';
const cut = appSrc.lastIndexOf(endMark);
assert(cut > 0, '未找到 app.js 的 IIFE 结尾');
const hook = '\n  globalThis.__T = {'
  + ' renderRank: renderRank, cityTooltipHtml: cityTooltipHtml, renderDetail: renderDetail,'
  + ' getFilteredCities: getFilteredCities, isRankableCity: isRankableCity, state: state,'
  + ' sortByHeat: sortByHeat, rawIndexText: rawIndexText,'
  + ' setRankList: function (o) { el.rankList = o; },'
  + ' setDetail: function (o) { el.detail = o; }'
  + ' };\n';
vm.runInContext(appSrc.slice(0, cut) + hook + appSrc.slice(cut), sandbox);

const T = sandbox.__T;
assert(!!T && typeof T.renderRank === 'function', '未取得 renderRank 钩子');

const rankList = makeElement();
const detail = makeElement();
T.setRankList(rankList);
T.setDetail(detail);

const PROVINCE_CITIES = sandbox.CITIES.filter((c) => c.src === 'province');
assert(PROVINCE_CITIES.length === 6, `province 口径城市应为 6 个，实际 ${PROVINCE_CITIES.length}`);

/**
 * 从榜单 HTML 里解析城市名。
 * @param {string} html 榜单 HTML。
 * @returns {string[]} 城市名数组。
 */
function rankNames(html) {
  const out = [];
  const re = /data-name="([^"]+)"/g;
  let m = re.exec(html);
  while (m) { out.push(m[1]); m = re.exec(html); }
  return out;
}

// ---------------------------------------------------- 1. 默认（全国）榜单
T.state.province = 'all';
T.state.heatMin = 0;
T.state.heatMax = 100;
T.state.keyword = '';
T.state.quick = '';
T.state.rankMode = 'cool';
T.renderRank(T.getFilteredCities());
const coolNames = rankNames(rankList.innerHTML);
assert(coolNames.length === 20, `最舒服榜应有 20 条，实际 ${coolNames.length}`);
const leaked = coolNames.filter((n) => PROVINCE_CITIES.some((c) => c.name === n));
assert(leaked.length === 0, `最舒服榜混入了省级汇总城市：${leaked.join('、')}`);
assert(coolNames.indexOf('三沙') !== -1, '三沙（真实数据 heat=0）应保持参与排名');
assert(rankList.innerHTML.indexOf('rank-note') === -1, '全国榜单不应出现口径提示');

// ---------------------------------------------------- 2. 香港 / 澳门不被误伤
const hk = sandbox.CITIES.find((c) => c.name === '香港');
const mo = sandbox.CITIES.find((c) => c.name === '澳门');
assert(hk && hk.src === 'real', '香港应为 real 口径');
assert(mo && mo.src === 'real', '澳门应为 real 口径');
assert(T.isRankableCity(hk) && T.isRankableCity(mo), '香港、澳门应参与排名');
T.state.rankMode = 'hot';
T.renderRank(T.getFilteredCities());
const hotNames = rankNames(rankList.innerHTML);
assert(hotNames.length === 20, `最挤榜应有 20 条，实际 ${hotNames.length}`);
assert(hotNames.indexOf('成都') !== -1, '最挤榜第一名应为成都');

// ---------------------------------------------------- 3. 只剩台湾省时的回退
T.state.province = '台湾';
const tw = T.getFilteredCities();
assert(tw.length === 6, `台湾省筛选应得到 6 个城市，实际 ${tw.length}`);
T.renderRank(tw);
const twNames = rankNames(rankList.innerHTML);
const twNoteShown = rankList.innerHTML.indexOf('rank-note') !== -1;
assert(twNames.length === 6, `台湾省榜单应回退显示 6 条，实际 ${twNames.length}`);
assert(twNoteShown, '台湾省榜单应附口径提示');
assert(rankList.innerHTML.indexOf('省级汇总口径') !== -1, '口径提示文案缺失');

// ---------------------------------------------------- 4. tooltip / 详情标注
const tp = PROVINCE_CITIES[0];
const tipHtml = T.cityTooltipHtml(tp);
assert(tipHtml.indexOf('tt-note') !== -1, 'tooltip 缺少 tt-note 口径标注');
assert(tipHtml.indexOf('与大陆城市不完全可比') !== -1, 'tooltip 口径文案缺失');
const tipNormal = T.cityTooltipHtml(hk);
assert(tipNormal.indexOf('tt-note') === -1, '香港 tooltip 不应出现口径标注（它是真实市级数据）');

T.state.selected = tp.name;
T.renderDetail();
assert(detail.innerHTML.indexOf('detail-note') !== -1, '详情面板缺少 detail-note 口径标注');
T.state.selected = hk.name;
T.renderDetail();
assert(detail.innerHTML.indexOf('detail-note') === -1, '香港详情不应出现口径标注');

// ---------------------------------------------------- 5. 并列 100 分按原始指数排序
const REAL = sandbox.CITIES.filter((c) => c.src === 'real');
const maxRaw = Math.max.apply(null, REAL.map((c) => c.raw));
const minRaw = Math.min.apply(null, REAL.map((c) => c.raw));
T.state.province = 'all';
T.state.heatMin = 0;
T.state.heatMax = 100;
T.state.keyword = '';
T.state.quick = '';
T.state.rankMode = 'hot';
T.renderRank(T.getFilteredCities());
const hot5 = rankNames(rankList.innerHTML).slice(0, 5);
assert(hot5[0] === '成都', `最挤 TOP1 应为成都（原始指数最大），实际 ${hot5[0]}`);
const top1 = REAL.find((c) => c.name === hot5[0]);
assert(top1 && top1.raw === maxRaw, `最挤 TOP1 的 raw 应为最大值 ${maxRaw}，实际 ${top1 && top1.raw}`);
assert(hot5.join('、') === '成都、广州、北京、深圳、上海',
  `最挤 TOP5 应按原始指数降序：成都、广州、北京、深圳、上海，实际 ${hot5.join('、')}`);

// 并列 100 分的城市，榜单内部顺序必须与 raw 降序完全一致
const heat100 = REAL.filter((c) => c.heat === 100).sort((a, b) => b.raw - a.raw);
const hotAll = rankNames(rankList.innerHTML);
const hot100 = hotAll.filter((n) => heat100.some((c) => c.name === n));
assert(hot100.join('、') === heat100.map((c) => c.name).join('、'),
  `heat=100 的 ${heat100.length} 个城市在榜单中应按 raw 降序排列`);

T.state.rankMode = 'cool';
T.renderRank(T.getFilteredCities());
const cool5 = rankNames(rankList.innerHTML).slice(0, 5);
assert(cool5[0] === '三沙', `最舒服 TOP1 应为三沙（原始指数最小），实际 ${cool5[0]}`);
const cool1 = REAL.find((c) => c.name === cool5[0]);
assert(cool1 && cool1.raw === minRaw, `最舒服 TOP1 的 raw 应为最小值 ${minRaw}，实际 ${cool1 && cool1.raw}`);

// sortByHeat 两个方向都要按 raw 打破平局
const tie = T.sortByHeat(REAL, true);
const tieDesc = tie.filter((c) => c.heat === 100).map((c) => c.raw);
assert(tieDesc.join() === tieDesc.slice().sort((a, b) => b - a).join(), '降序并列项未按 raw 降序');
const tieAsc = T.sortByHeat(REAL, false).filter((c) => c.heat === 0).map((c) => c.raw);
assert(tieAsc.join() === tieAsc.slice().sort((a, b) => a - b).join(), '升序并列项未按 raw 升序');

// ---------------------------------------------------- 6. 原始指数展示
const chengdu = REAL.find((c) => c.name === '成都');
const cdTip = T.cityTooltipHtml(chengdu);
assert(cdTip.indexOf('21.43') !== -1, `成都 tooltip 应显示原始指数 21.43，实际片段：${cdTip.slice(0, 0) || '未找到'}`);
assert(cdTip.indexOf('全国第 1') !== -1, '成都 tooltip 应显示「全国第 1」');
assert(T.rawIndexText(chengdu) === '21.43（全国第 1）', `rawIndexText 输出异常：${T.rawIndexText(chengdu)}`);
T.state.selected = chengdu.name;
T.renderDetail();
assert(detail.innerHTML.indexOf('原始迁入规模指数 21.43') !== -1, '详情面板应显示原始迁入规模指数');

// ---------------------------------------------------- 7. 筛选与地图散点不受影响
T.state.province = 'all';
T.state.selected = '';
const all = T.getFilteredCities();
assert(all.length === sandbox.CITIES.length, `筛选结果应与全量一致，实际 ${all.length}`);
assert(all.filter((c) => c.src === 'province').length === 6, '台湾 6 市必须仍在散点与筛选结果中');
T.state.keyword = '台北';
assert(T.getFilteredCities().length === 1, '搜索「台北」应命中 1 个城市');
T.state.keyword = '';
T.state.province = '香港';
assert(T.getFilteredCities().length === 1, '省份筛选「香港」应命中 1 个城市');

// ---------------------------------------------------- 报告
console.log('\n============ 省级汇总口径榜单行为 QA ============');
console.log(`province 口径城市：${PROVINCE_CITIES.map((c) => c.name).join('、')}`);
console.log(`全国最舒服榜 TOP5：${coolNames.slice(0, 5).join('、')}`);
console.log(`全国最挤榜 TOP5：${hot5.slice(0, 5).join('、')}（原始指数：${hot5.map((n) => {
  const c = REAL.find((x) => x.name === n);
  return c ? c.raw : '?';
}).join(' / ')}）`);
console.log(`台湾省榜单：${twNames.join('、')}（含口径提示：${twNoteShown}）`);
console.log(`\n通过断言：${passed}`);
console.log(`失败断言：${failures.length}`);
if (failures.length) {
  console.log('\n--- 失败明细 ---');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
}
console.log('\n结果：' + (failures.length === 0 ? 'PASS' : 'FAIL'));
process.exit(failures.length === 0 ? 0 : 1);
