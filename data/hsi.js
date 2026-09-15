/* ------------------------------------------------------------------ *
 * data/hsi.js —— 住宿紧张指数（Holiday Stay Index, HSI）数据集
 *
 * 为什么需要它
 *   百度迁徙最小粒度是地级行政区，奉节/巫山/巴东/秭归这类县级行政区拿不到数据，
 *   只能做「官方数据专题」——那不是通用解法。
 *   酒店价格是唯一能下沉到县级、且口径可标准化的公开指标：
 *   县级城市同样有连锁酒店报价，同一品牌、同一房型、平日 vs 假日的配对涨幅，
 *   在全国任何城市（含县）都可以用同一把尺子量。
 *
 * 指标定义
 *   raw  = 假期价 / 平日价                    （同店、同房型配对）
 *   lnp  = ln(raw)                            （涨幅是重尾分布，取对数压缩极端值）
 *   HSI  = lnp 在「同一年份」内的百分位 × 100  （年内相对位置，0-100）
 *
 * ⚠️ 跨年只比排名、不比数值
 *   各年的样本品牌、采集平台、对比日期都不一样（见 yearMeta），
 *   全国整体的涨价水平逐年变化很大（2023 暴涨、2024 明显回落），
 *   所以 HSI 一律「年内归一」：HSI=80 只表示「该年最紧张的 20% 之一」，
 *   不代表 2023 的 80 和 2025 的 80 涨幅相同。
 *
 * 已知偏差（使用时必须知道）
 *   1. 档次结构：高端品牌国庆反而降价（2025 年希尔顿 -15.8%、喜来登 -16.5%）,
 *      因此样本只取经济型/中端连锁，混入高端会系统性低估。
 *   2. 基数效应：平日价越低的城市，百分比涨幅天然越大（分母小）。
 *      阳朔 155→711（3.6 倍）≠ 比北京 530→852（0.6 倍）人多，
 *      它衡量的是「供需紧张度」，不是客流规模。
 *   3. 供给弹性：小城市房源少，涨得猛但绝对客流小，需结合迁徙强度一起看。
 *   4. 样本量：公开榜每城仅 1 家「举例酒店」，噪声大，已按 n 标注可信度。
 *
 * 本文件由人工核对公开报道整理 + tools/ 脚本校验，来源见 yearMeta。
 * ------------------------------------------------------------------ */

(function (global) {
  'use strict';

  var meta = {
    metric: 'HSI · 住宿紧张指数',
    formula: 'HSI = 年内百分位( ln(假期价 / 平日价) ) × 100',
    reading: '越高 = 假期住宿越紧张、溢价越猛；它衡量「供需紧张度」，不等于客流规模',
    caution: '跨年只比排名不比数值；公开榜每城仅 1 家举例酒店，属低样本参考值'
  };

  var yearMeta = {
    2023: {
      source: 'DT商业观察 / 真叫卢俊《2023 年全国部分城市经济型酒店国庆价格对比》',
      platform: 'OTA 公开报价',
      brand: '混合（希岸 / 如家 / 汉庭 / 全季 / 亚朵 / 维也纳 / 丽枫 / 桔子等）',
      baseline: '国庆前一周',
      holiday: '国庆期间',
      room: '各店举例房型',
      n: 24,
      rankable: true,
      note: '每城仅一家「举例酒店」，且品牌档次不统一（含中端亚朵、全季），与 2025 统一汉庭口径不可直接比数值。原榜 25 行，其中「贵州」为省级、指向不明，已剔除'
    },
    2024: {
      source: '真叫卢俊 2024 国庆统计',
      platform: 'OTA 公开报价',
      brand: '世贸大酒店',
      baseline: '国庆前',
      holiday: '国庆期间',
      room: '—',
      n: 1,
      rankable: false,
      note: '仅检索到 1 个公开数据点（原文榜单为图片，数字无法提取）。样本不足，不参与排名，仅作参考点'
    },
    2025: {
      source: '羊城晚报「记者帮」《国庆酒店涨幅榜》',
      platform: '飞猪 App',
      brand: '汉庭（经济型连锁，统一口径）',
      baseline: '2025-09-26（工作日）',
      holiday: '2025-10-03（假期高峰）',
      room: '大床房 / 高级大床房',
      n: 50,
      rankable: true,
      note: '口径最干净的一年（统一平台 + 统一品牌 + 统一房型 + 统一日期），作为跨年校准基准'
    },
    2026: {
      source: '自建采集',
      platform: '待定',
      brand: '经济型连锁（拟汉庭 / 如家）',
      baseline: '2026-09-16 — 09-26',
      holiday: '2026-10-02 — 10-04',
      room: '大床房最低价',
      n: 0,
      rankable: false,
      note: '采集需要 OTA 登录态，自动化受限，见 tools/README 说明'
    }
  };

  /* 字段：y 年份 | city 名称 | hotel 举例门店 | brand 品牌 | p0 平日价 | p1 假期价
   *       ratio 涨幅倍数（p1/p0-1，小数）| onMap 是否能在主图点位中找到 */
  var records = [
    /* ---------------- 2025 · 统一汉庭口径（羊城晚报） ---------------- */
    { y: 2025, city: '澳门', hotel: '澳门巴黎人', brand: '巴黎人', p0: 849, p1: 5534, onMap: true },
    { y: 2025, city: '阳朔', hotel: '汉庭桂林阳朔西街新店', brand: '汉庭', p0: 155, p1: 711, onMap: false, parent: '桂林' },
    { y: 2025, city: '潮州', hotel: '汉庭潮州古城酒店', brand: '汉庭', p0: 183, p1: 747, onMap: true },
    { y: 2025, city: '汕头', hotel: '汉庭汕头海滨长廊红领巾路酒店', brand: '汉庭', p0: 229, p1: 865, onMap: true },
    { y: 2025, city: '桂林', hotel: '汉庭优佳桂林正阳步行街酒店', brand: '汉庭', p0: 192, p1: 715, onMap: true },
    { y: 2025, city: '绍兴', hotel: '汉庭绍兴鲁迅故里店', brand: '汉庭', p0: 238, p1: 845, onMap: true },
    { y: 2025, city: '北海', hotel: '汉庭北海老街北部湾广场酒店', brand: '汉庭', p0: 183, p1: 643, onMap: true },
    { y: 2025, city: '厦门', hotel: '汉庭厦门中山路步行街大同路酒店', brand: '汉庭', p0: 192, p1: 666, onMap: true },
    { y: 2025, city: '徐州', hotel: '汉庭徐州苏宁广场店', brand: '汉庭', p0: 266, p1: 891, onMap: true },
    { y: 2025, city: '连云港', hotel: '汉庭连云港墟沟嘉瑞宝购物广场店', brand: '汉庭', p0: 192, p1: 643, onMap: true },
    { y: 2025, city: '珠海', hotel: '汉庭珠海拱北口岸店', brand: '汉庭', p0: 247, p1: 803, onMap: true },
    { y: 2025, city: '延边', hotel: '汉庭长白山二道白河高铁站酒店', brand: '汉庭', p0: 303, p1: 928, onMap: true },
    { y: 2025, city: '香港', hotel: '香港尖沙咀皇悦酒店', brand: '皇悦', p0: 619, p1: 1856, onMap: true },
    { y: 2025, city: '洛阳', hotel: '汉庭洛阳洛邑古城酒店', brand: '汉庭', p0: 266, p1: 783, onMap: true },
    { y: 2025, city: '宜昌', hotel: '汉庭宜昌东站店', brand: '汉庭', p0: 211, p1: 616, onMap: true },
    { y: 2025, city: '湛江', hotel: '汉庭湛江霞山步行街店', brand: '汉庭', p0: 120, p1: 345, onMap: true },
    { y: 2025, city: '杭州', hotel: '汉庭杭州西湖湖滨店', brand: '汉庭', p0: 257, p1: 734, onMap: true },
    { y: 2025, city: '西双版纳', hotel: '汉庭西双版纳告庄西双景酒店', brand: '汉庭', p0: 146, p1: 414, onMap: true },
    { y: 2025, city: '柳州', hotel: '汉庭柳州火车站城站路酒店', brand: '汉庭', p0: 220, p1: 615, onMap: true },
    { y: 2025, city: '大连', hotel: '汉庭大连中山广场店', brand: '汉庭', p0: 293, p1: 802, onMap: true },
    { y: 2025, city: '哈尔滨', hotel: '汉庭哈尔滨中央大街店', brand: '汉庭', p0: 238, p1: 639, onMap: true },
    { y: 2025, city: '温州', hotel: '汉庭温州五马街店', brand: '汉庭', p0: 238, p1: 594, onMap: true },
    { y: 2025, city: '漳州', hotel: '汉庭漳州龙江大厦酒店', brand: '汉庭', p0: 257, p1: 639, onMap: true },
    { y: 2025, city: '南宁', hotel: '汉庭南宁朝阳广场店', brand: '汉庭', p0: 174, p1: 428, onMap: true },
    { y: 2025, city: '南昌', hotel: '汉庭南昌八一广场店', brand: '汉庭', p0: 277, p1: 681, onMap: true },
    { y: 2025, city: '常州', hotel: '汉庭常州青果巷酒店', brand: '汉庭', p0: 238, p1: 579, onMap: true },
    { y: 2025, city: '贵阳', hotel: '汉庭贵阳喷水池紫林庵地铁站酒店', brand: '汉庭', p0: 275, p1: 666, onMap: true },
    { y: 2025, city: '台州', hotel: '汉庭台州椒江商业街酒店', brand: '汉庭', p0: 201, p1: 477, onMap: true },
    { y: 2025, city: '香格里拉', hotel: '汉庭香格里拉古城酒店', brand: '汉庭', p0: 349, p1: 820, onMap: false, parent: '迪庆' },
    { y: 2025, city: '烟台', hotel: '汉庭烟台北马路万达酒店', brand: '汉庭', p0: 257, p1: 603, onMap: true },
    { y: 2025, city: '长沙', hotel: '汉庭长沙五一广场步行街店', brand: '汉庭', p0: 303, p1: 684, onMap: true },
    { y: 2025, city: '广州', hotel: '汉庭广州北京路步行街店', brand: '汉庭', p0: 349, p1: 782, onMap: true },
    { y: 2025, city: '武汉', hotel: '汉庭武汉江汉路步行街店', brand: '汉庭', p0: 284, p1: 634, onMap: true },
    { y: 2025, city: '济南', hotel: '汉庭济南泉城广场店', brand: '汉庭', p0: 247, p1: 549, onMap: true },
    { y: 2025, city: '成都', hotel: '汉庭成都春熙路太古里中心酒店', brand: '汉庭', p0: 284, p1: 630, onMap: true },
    { y: 2025, city: '上海', hotel: '汉庭上海南京路步行街中心店', brand: '汉庭', p0: 358, p1: 744, onMap: true },
    { y: 2025, city: '江门', hotel: '汉庭江门三十三墟街地王广场酒店', brand: '汉庭', p0: 183, p1: 378, onMap: true },
    { y: 2025, city: '三亚', hotel: '汉庭三亚三亚湾酒店', brand: '汉庭', p0: 211, p1: 423, onMap: true },
    { y: 2025, city: '呼和浩特', hotel: '汉庭呼和浩特文化宫路酒店', brand: '汉庭', p0: 229, p1: 414, onMap: true },
    { y: 2025, city: '太原', hotel: '汉庭太原火车站西广场地铁站酒店', brand: '汉庭', p0: 192, p1: 342, onMap: true },
    { y: 2025, city: '佛山', hotel: '汉庭佛山千灯湖怡海港店', brand: '汉庭', p0: 220, p1: 376, onMap: true },
    { y: 2025, city: '深圳', hotel: '汉庭深圳罗湖口岸万象城酒店', brand: '汉庭', p0: 316, p1: 538, onMap: true },
    { y: 2025, city: '北京', hotel: '汉庭北京王府井店', brand: '汉庭', p0: 530, p1: 852, onMap: true },
    { y: 2025, city: '临沂', hotel: '汉庭临沂郯城人民路酒店', brand: '汉庭', p0: 174, p1: 279, onMap: true },
    { y: 2025, city: '西宁', hotel: '汉庭西宁湟光莫家街酒店', brand: '汉庭', p0: 174, p1: 278, onMap: true },
    { y: 2025, city: '南充', hotel: '汉庭南充五星花园酒店', brand: '汉庭', p0: 201, p1: 321, onMap: true },
    { y: 2025, city: '南通', hotel: '汉庭南通通州金鹰广场店', brand: '汉庭', p0: 183, p1: 266, onMap: true },
    { y: 2025, city: '商丘', hotel: '汉庭商丘民权火车北站酒店', brand: '汉庭', p0: 174, p1: 243, onMap: true },
    { y: 2025, city: '周口', hotel: '汉庭周口太昊路酒店', brand: '汉庭', p0: 136, p1: 142, onMap: true },
    { y: 2025, city: '东莞', hotel: '汉庭东莞市政府国贸酒店', brand: '汉庭', p0: 192, p1: 197, onMap: true },

    /* ---------------- 2023 · 混合品牌单店（DT商业观察） ---------------- */
    { y: 2023, city: '景德镇', hotel: '希岸酒店', brand: '希岸', p0: 266, p1: 1394, onMap: true },
    { y: 2023, city: '柳州', hotel: '如家酒店', brand: '如家', p0: 132, p1: 657, onMap: true },
    { y: 2023, city: '阳朔', hotel: '汉庭', brand: '汉庭', p0: 152, p1: 646, onMap: false, parent: '桂林' },
    { y: 2023, city: '香港', hotel: '卓越酒店', brand: '卓越', p0: 609, p1: 2338, onMap: true },
    { y: 2023, city: '安吉', hotel: '世贸大酒店', brand: '世贸', p0: 312, p1: 1112, onMap: false, parent: '湖州' },
    { y: 2023, city: '淄博', hotel: '丽悦酒店', brand: '丽悦', p0: 240, p1: 854, onMap: true },
    { y: 2023, city: '临海', hotel: '全季', brand: '全季', p0: 306, p1: 1033, onMap: false, parent: '台州' },
    { y: 2023, city: '汕头', hotel: '希岸酒店', brand: '希岸', p0: 257, p1: 865, onMap: true },
    { y: 2023, city: '西昌', hotel: '桔子酒店', brand: '桔子', p0: 223, p1: 740, onMap: false, parent: '凉山' },
    { y: 2023, city: '大连', hotel: '亚朵', brand: '亚朵', p0: 403, p1: 1337, onMap: true },
    { y: 2023, city: '青岛', hotel: '维也纳', brand: '维也纳', p0: 114, p1: 356, onMap: true },
    { y: 2023, city: '天津', hotel: '丽枫酒店', brand: '丽枫', p0: 281, p1: 860, onMap: true },
    { y: 2023, city: '泉州', hotel: '全季', brand: '全季', p0: 288, p1: 819, onMap: true },
    { y: 2023, city: '北海', hotel: '维也纳', brand: '维也纳', p0: 358, p1: 1018, onMap: true },
    { y: 2023, city: '大理', hotel: '维也纳', brand: '维也纳', p0: 284, p1: 758, onMap: true },
    { y: 2023, city: '三亚', hotel: '丽枫酒店（三亚湾）', brand: '丽枫', p0: 267, p1: 706, onMap: true },
    { y: 2023, city: '重庆', hotel: '全季', brand: '全季', p0: 399, p1: 969, onMap: true },
    { y: 2023, city: '成都', hotel: '桔子酒店', brand: '桔子', p0: 409, p1: 978, onMap: true },
    { y: 2023, city: '苏州', hotel: '亚朵', brand: '亚朵', p0: 420, p1: 934, onMap: true },
    { y: 2023, city: '长沙', hotel: '亚朵', brand: '亚朵', p0: 456, p1: 985, onMap: true },
    { y: 2023, city: '秦皇岛', hotel: '丽枫酒店', brand: '丽枫', p0: 244, p1: 489, onMap: true },
    { y: 2023, city: '庐山', hotel: '全季', brand: '全季', p0: 288, p1: 502, onMap: false, parent: '九江' },
    { y: 2023, city: '上海', hotel: '亚朵（上海迪士尼）', brand: '亚朵', p0: 420, p1: 608, onMap: true },
    { y: 2023, city: '北京', hotel: '亚朵', brand: '亚朵', p0: 561, p1: 702, onMap: true },

    /* ---------------- 2024 · 仅 1 个公开点，不参与排名 ---------------- */
    { y: 2024, city: '安吉', hotel: '世贸大酒店', brand: '世贸', p0: 261, p1: 888, onMap: false, parent: '湖州' }
  ];

  /* 计算年内百分位 HSI */
  records.forEach(function (r) {
    r.raw = r.p1 / r.p0;
    r.pct = Math.round((r.raw - 1) * 1000) / 10; /* 涨幅百分比，如 358.7 */
    r.lnp = Math.log(r.raw);
  });

  var MIN_RANKABLE = 10;
  Object.keys(yearMeta).forEach(function (y) {
    var ys = Number(y);
    var rows = records.filter(function (r) { return r.y === ys; });
    if (!yearMeta[y].rankable || rows.length < MIN_RANKABLE) {
      rows.forEach(function (r) { r.hsi = null; });
      return;
    }
    var sorted = rows.slice().sort(function (a, b) { return a.lnp - b.lnp; });
    var n = sorted.length;
    sorted.forEach(function (r, i) {
      r.hsi = n > 1 ? Math.round((i / (n - 1)) * 1000) / 10 : 50;
      r.rank = n - i; /* 1 = 最紧张 */
    });
  });

  /* 城市 -> { 2025: {...}, 2023: {...} } 便于前端查表 */
  var byCity = {};
  records.forEach(function (r) {
    if (!byCity[r.city]) byCity[r.city] = {};
    byCity[r.city][r.y] = r;
  });

  var rankableYears = Object.keys(yearMeta)
    .map(Number)
    .filter(function (y) { return yearMeta[y].rankable && records.filter(function (r) { return r.y === y; }).length >= MIN_RANKABLE; })
    .sort(function (a, b) { return b - a; });

  /* 取某城市在「最新可排名年份」的 HSI（会跨年 fallback，仅供详情展示历史） */
  function latest(city) {
    var m = byCity[city];
    if (!m) return null;
    for (var i = 0; i < rankableYears.length; i++) {
      if (m[rankableYears[i]] && m[rankableYears[i]].hsi != null) return m[rankableYears[i]];
    }
    return null;
  }

  /**
   * 取某城市在「主年份」的 HSI。
   * ⚠️ 排名、地图着色、四象限一律只用主年份：HSI 是年内百分位，
   *    不同年份的样本品牌与采集日期不同，混在一起排是不严谨的。
   */
  var primaryYear = rankableYears[0] || null;

  function primary(city) {
    var m = byCity[city];
    if (!m || !primaryYear) return null;
    var r = m[primaryYear];
    return (r && r.hsi != null) ? r : null;
  }

  /** 取某城市除主年份以外的历史样本，按年份倒序。 */
  function historyOf(city) {
    var m = byCity[city];
    if (!m) return [];
    return rankableYears
      .filter(function (y) { return y !== primaryYear && m[y] && m[y].hsi != null; })
      .map(function (y) { return m[y]; });
  }

  global.HSI = {
    meta: meta,
    yearMeta: yearMeta,
    records: records,
    byCity: byCity,
    rankableYears: rankableYears,
    latest: latest,
    primary: primary,
    historyOf: historyOf,
    primaryYear: primaryYear
  };
})(window);
