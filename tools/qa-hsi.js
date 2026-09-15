/* tools/qa-hsi.js —— 住宿紧张指数（HSI）数据自检
 * 运行：node tools/qa-hsi.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name + (extra ? '  ' + extra : ''));
  } else {
    fail++;
    console.log('  FAIL  ' + name + (extra ? '  ' + extra : ''));
  }
}
function load(file, exportName) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.window[exportName];
}

const CITIES = load('data/cities.js', 'CITIES');
const HSI = load('data/hsi.js', 'HSI');

console.log('=== HSI 数据自检 ===');

ok('CITIES 数量 = 359', CITIES.length === 359, '实际 ' + CITIES.length);
ok('HSI 记录非空', HSI.records.length > 0, HSI.records.length + ' 条');

/* 1. 基础字段完整性 */
const bad = HSI.records.filter((r) => !(r.y && r.city && r.p0 > 0 && r.p1 > 0 && r.brand));
ok('每条记录都有 年份/城市/平日价/假期价/品牌', bad.length === 0, bad.length ? JSON.stringify(bad[0]) : '');

/* 2. 价格必须为正且假期价 >= 平日价的合理范围 */
const neg = HSI.records.filter((r) => r.p0 <= 0 || r.p1 <= 0);
ok('价格均为正数', neg.length === 0);
const lowRatio = HSI.records.filter((r) => r.raw < 0.5);
ok('无异常跌幅（raw < 0.5）', lowRatio.length === 0, lowRatio.map((r) => r.city + ':' + r.raw.toFixed(2)).join(','));
const highRatio = HSI.records.filter((r) => r.raw > 10);
ok('无离谱涨幅（raw > 10）', highRatio.length === 0, highRatio.map((r) => r.city + ':' + r.raw.toFixed(1)).join(','));

/* 3. yearMeta 的 n 与实际记录数一致 */
Object.keys(HSI.yearMeta).forEach((y) => {
  const actual = HSI.records.filter((r) => String(r.y) === y).length;
  ok('yearMeta[' + y + '].n 与实际一致', HSI.yearMeta[y].n === actual, 'meta=' + HSI.yearMeta[y].n + ' actual=' + actual);
});

/* 4. HSI 计算正确性 */
HSI.rankableYears.forEach((y) => {
  const rows = HSI.records.filter((r) => r.y === y);
  const withHsi = rows.filter((r) => r.hsi != null);
  ok(y + ' 全部记录都有 HSI', withHsi.length === rows.length, withHsi.length + '/' + rows.length);
  const sorted = rows.slice().sort((a, b) => a.lnp - b.lnp);
  let mono = true;
  for (let i = 1; i < sorted.length; i++) if (sorted[i].hsi < sorted[i - 1].hsi) mono = false;
  ok(y + ' HSI 随 ln 涨幅单调递增', mono);
  ok(y + ' HSI 落在 0-100', rows.every((r) => r.hsi >= 0 && r.hsi <= 100));
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  ok(y + ' 最低/最高 HSI = 0/100', min.hsi === 0 && max.hsi === 100, min.city + '=' + min.hsi + ' , ' + max.city + '=' + max.hsi);
  ok(y + ' 排名最紧张的是涨幅最大的', max.rank === 1 && max.city === sorted[sorted.length - 1].city, 'No.1 = ' + max.city);
});

/* 5. 样本不足的年份不参与排名 */
const nonRank = HSI.rankableYears.length ? Object.keys(HSI.yearMeta).filter((y) => HSI.rankableYears.indexOf(Number(y)) < 0) : [];
nonRank.forEach((y) => {
  const rows = HSI.records.filter((r) => String(r.y) === y);
  ok(y + ' 样本不足，HSI 置空不参与排名', rows.every((r) => r.hsi === null), rows.length + ' 条');
});

/* 6. 与地图城市名的匹配率 */
const onMap = HSI.records.filter((r) => r.onMap !== false);
const cityNames = new Set(CITIES.map((c) => c.name));
const unmatched = onMap.filter((r) => !cityNames.has(r.city));
ok('标注 onMap 的记录都能在主图城市中找到', unmatched.length === 0, unmatched.map((r) => r.city).join(',') || '全部命中');
const offMap = HSI.records.filter((r) => r.onMap === false);
ok('offMap 记录都带 parent 归属', offMap.every((r) => !!r.parent), offMap.map((r) => r.city + '→' + r.parent).join(', '));

/* 7. 主年份覆盖率 */
const py = HSI.primaryYear;
const pyRows = HSI.records.filter((r) => r.y === py);
const hit = CITIES.filter((c) => HSI.byCity[c.name] && HSI.byCity[c.name][py]);
console.log('  INFO  主年份 = ' + py + '，覆盖 ' + pyRows.length + ' 个样本，命中主图 ' + hit.length + '/' + CITIES.length + ' 城');
ok('主年份命中城市数 > 30', hit.length > 30, hit.length + ' 城');

console.log('  INFO  主年份 = ' + py + '，覆盖 ' + pyRows.length + ' 个样本，命中主图 ' + hit.length + '/' + CITIES.length + ' 城');
ok('主年份命中城市数 > 30', hit.length > 30, hit.length + ' 城');
const pyCities = new Set(pyRows.map((r) => r.city));
const mixed = CITIES.filter((c) => !HSI.primary(c.name) && !!HSI.latest(c.name));
console.log('  INFO  仅在历史年份有数据、主年份无数据的城市：' + mixed.length + ' 个（如 ' + mixed.slice(0, 5).map((c) => c.name).join(',') + '）');
ok('存在「仅历史年份有数据」的城市（用于验证 primary 会正确排除）', mixed.length > 0, mixed.length + ' 个');
ok('primary() 对这些城市一律返回 null', mixed.every((c) => HSI.primary(c.name) === null));

/* 9. latest / primary / historyOf 可用性 */
const sample = ['北京', '阳朔', '潮州', '奉节', '景德镇'];
sample.forEach((c) => {
  const p = HSI.primary(c);
  const l = HSI.latest(c);
  const h = HSI.historyOf(c);
  console.log('  INFO  ' + c + '  primary=' + (p ? p.y + '/HSI' + p.hsi : 'null')
    + '  latest=' + (l ? l.y + '/HSI' + l.hsi : 'null')
    + '  history=' + h.map((r) => r.y).join(','));
});
ok('primary("北京") 有值', !!HSI.primary('北京'));
ok('primary("阳朔") 有值（县级可覆盖）', !!HSI.primary('阳朔'));
ok('primary("奉节") 为 null（暂无酒店数据，待 2026 采集）', HSI.primary('奉节') === null);
ok('景德镇主年份无数据、但历史可查（latest 能拿到 2023）',
  HSI.primary('景德镇') === null && HSI.latest('景德镇') !== null && HSI.latest('景德镇').y === 2023);

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
