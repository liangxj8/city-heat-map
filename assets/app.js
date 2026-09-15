/* global echarts */
/* ==========================================================================
 * 国庆去哪儿 · 全国城市热度地图 —— 交互逻辑
 *
 * 分区：
 *   0. 常量配置
 *   1. 运行时状态
 *   2. 工具函数（helpers）
 *   3. 数据计算（data）
 *   4. 渲染（render）
 *   5. 事件绑定（events）
 *   6. 初始化（init）
 *
 * 依赖（均由 index.html 以本地文件方式引入，无任何 CDN / 网络请求）：
 *   assets/echarts.min.js  -> window.echarts
 *   data/geo.js            -> window.CHINA_GEO
 *   data/cities.js         -> window.CITIES
 * ========================================================================== */

(function () {
  'use strict';

  /* ======================================================================
   * 0. 常量配置
   * ==================================================================== */

  /** 省级行政区「简称 -> GeoJSON 全称」映射（民政部行政区划标准命名）。 */
  var PROVINCE_FULL_NAME = {
    '北京': '北京市', '天津': '天津市', '河北': '河北省', '山西': '山西省',
    '内蒙古': '内蒙古自治区', '辽宁': '辽宁省', '吉林': '吉林省', '黑龙江': '黑龙江省',
    '上海': '上海市', '江苏': '江苏省', '浙江': '浙江省', '安徽': '安徽省',
    '福建': '福建省', '江西': '江西省', '山东': '山东省', '河南': '河南省',
    '湖北': '湖北省', '湖南': '湖南省', '广东': '广东省', '广西': '广西壮族自治区',
    '海南': '海南省', '重庆': '重庆市', '四川': '四川省', '贵州': '贵州省',
    '云南': '云南省', '西藏': '西藏自治区', '陕西': '陕西省', '甘肃': '甘肃省',
    '青海': '青海省', '宁夏': '宁夏回族自治区', '新疆': '新疆维吾尔自治区',
    '台湾': '台湾省', '香港': '香港特别行政区', '澳门': '澳门特别行政区'
  };

  /** 「GeoJSON 全称 -> 简称」反查表（运行时构建）。 */
  var FULL_NAME_TO_SHORT = {};

  /** 省级行政区简称列表（保持声明顺序）。 */
  var PROVINCE_LIST = Object.keys(PROVINCE_FULL_NAME);

  /** 拥挤等级：按 min 从高到低匹配；desc 用于 tooltip 补充说明。 */
  var CROWD_LEVELS = [
    { min: 85, label: '爆满', color: '#9e1b32', desc: '人山人海，建议错峰或改期' },
    { min: 70, label: '拥挤', color: '#e4573d', desc: '核心景区排队明显' },
    { min: 50, label: '适中', color: '#f4925d', desc: '热门点有人，整体可逛' },
    { min: 30, label: '舒适', color: '#4fc3a1', desc: '人流可控，体验较好' },
    { min: 0, label: '冷清', color: '#3aa0ff', desc: '游客稀少，深度慢游' }
  ];

  /** 热度连续色带（冷=人少 -> 暖=人多），与 visualMap.inRange 共用。 */
  var HEAT_COLORS = ['#3aa0ff', '#4fc3a1', '#ffd166', '#f4925d', '#e4573d', '#9e1b32'];

  /** 快捷筛选按钮配置。test 为命中判定函数。 */
  var QUICK_FILTERS = [
    {
      key: 'quiet', label: '只看人少的',
      test: function (c) { return c.heat < 50; }
    },
    {
      key: 'crowded', label: '爆满预警',
      test: function (c) { return c.heat >= 85; }
    },
    {
      key: 'coast', label: '海滨海岛',
      test: function (c) { return hasTag(c, '海滨海岛'); }
    },
    {
      key: 'oldtown', label: '古镇古城',
      test: function (c) { return hasTag(c, '古镇古城'); }
    },
    {
      key: 'nature', label: '自然风光',
      test: function (c) { return hasTag(c, '自然风光'); }
    },
    {
      key: 'hidden', label: '小众秘境',
      test: function (c) { return hasTag(c, '小众秘境'); }
    },
    {
      key: 'autumn', label: '秋色限定',
      test: function (c) { return hasTag(c, '秋色'); }
    },
    {
      key: 'food', label: '美食之旅',
      test: function (c) { return hasTag(c, '美食'); }
    }
  ];

  /** 地图默认缩放级别。 */
  var DEFAULT_ZOOM = 1.25;
  /** 选中城市后的缩放级别（气泡视图）。 */
  var FOCUS_ZOOM = 6;
  /** 选中城市 / 省份后的缩放级别（省份填充视图）。 */
  var FOCUS_ZOOM_PROVINCE = 4.6;
  /** 仅按省份筛选时的缩放级别。 */
  var PROVINCE_ZOOM = 4.6;
  /** 排行榜展示条数。 */
  var RANK_SIZE = 20;

  /**
   * 省级汇总口径（src === 'province'）城市的数据说明。
   * 这类城市百度迁徙覆盖有限，指数与大陆城市不完全可比，
   * 因此默认不参与热度榜单排名，并在 tooltip / 详情里显式标注。
   */
  var SRC_PROVINCE_NOTE = '百度迁徙对该地区数据覆盖有限，本指数为省级汇总口径，与大陆城市不完全可比。';

  /**
   * 三峡专题点位（src === 'official'，奉节/巫山/巴东/秭归）的数据说明。
   * 这四个是县级行政区，百度迁徙最小粒度是地级行政区、拿不到数据，因此改用
   * 地方政府官方发布的假日旅游统计。四县口径互不相同（景区购票 / 全县接待 /
   * A 级景区），彼此不可比、更不能与迁徙指数比较，所以只展示原始数据并标注口径，
   * 不参与热度排名，也不做折算。
   */
  var SRC_OFFICIAL_NOTE = '本点位为「三峡专题」，数据来自地方政府官方发布的 2025 年国庆假日旅游统计，'
    + '统计口径与全国迁徙热度指数不可比，故不参与热度排名，也不与其他城市横向比较。';

  /** 三峡专题点位的专题色（区别于常规热度的冷暖渐变色带）。 */
  var OFFICIAL_COLOR = '#0d9488';

  /** 住宿紧张指数（HSI）的色带：青（宽松）-> 琥珀 -> 红（一房难求）。 */
  var HSI_COLORS = ['#3aa0ff', '#4fc3a1', '#ffd166', '#f4925d', '#e4573d', '#9e1b32'];

  /** HSI 五档语义（与数值区间一致，仅用于文案与图例）。 */
  var HSI_LEVELS = [
    { min: 85, label: '一房难求', color: '#9e1b32', desc: '住宿极度紧张，务必提前订' },
    { min: 70, label: '明显溢价', color: '#e4573d', desc: '假期房价大幅上浮' },
    { min: 50, label: '温和上涨', color: '#f4925d', desc: '价格有上浮但可接受' },
    { min: 30, label: '基本平稳', color: '#4fc3a1', desc: '房价与平日接近' },
    { min: 0, label: '价格洼地', color: '#3aa0ff', desc: '几乎不涨价，性价比高' }
  ];

  /** 两个可切换指标的配置。 */
  var METRICS = {
    heat: {
      key: 'heat',
      label: '国庆热度',
      unit: '客流强度',
      colors: HEAT_COLORS,
      levels: CROWD_LEVELS,
      text: ['爆满 100', '冷清 0'],
      desc: '百度迁徙迁入规模，衡量「有多少人去」'
    },
    hsi: {
      key: 'hsi',
      label: '住宿紧张度',
      unit: 'HSI',
      colors: HSI_COLORS,
      levels: HSI_LEVELS,
      text: ['一房难求 100', '价格洼地 0'],
      desc: '连锁酒店假期溢价，衡量「住宿有多紧张」'
    }
  };

  /**
   * HSI 口径说明（任何时候展示 HSI 都要带上，避免被误读成人多）。
   * 跨年只比排名不比数值：各年样本品牌与采集日期不同。
   */
  var HSI_NOTE = '住宿紧张度（HSI）＝ 连锁酒店「假期价 ÷ 平日价」在同一年份内的百分位。'
    + '它衡量的是供需紧张程度，不是客流规模：小城房源少也可能涨幅很高。'
    + '跨年只比排名、不比数值。';

  /* ======================================================================
   * 1. 运行时状态
   * ==================================================================== */

  var state = {
    view: 'scatter',        // 'scatter' 城市热度气泡 | 'province' 省份热度填充
    province: 'all',        // 省份简称，'all' 表示全部
    heatMin: 0,
    heatMax: 100,
    keyword: '',
    quick: '',              // QUICK_FILTERS 中的 key，'' 表示未启用
    selected: '',           // 当前选中的城市名
    rankMode: 'hot',        // 'hot' 最挤 | 'cool' 最舒服
    metric: 'heat',         // 'heat' 国庆热度（客流） | 'hsi' 住宿紧张度（价格）
    mapCenter: null,        // [lng, lat] 或 null（自动居中）
    mapZoom: DEFAULT_ZOOM
  };

  /** ECharts 实例。 */
  var chart = null;
  /** 上一次渲染的视图，用于判断是否需要 replaceMerge。 */
  var lastView = null;
  /** DOM 缓存。 */
  var el = {};
  /** 省份简称 -> [lng, lat] 中心点（来自 GeoJSON properties.center）。 */
  var provinceCenter = {};

  /* ======================================================================
   * 2. 工具函数（helpers）
   * ==================================================================== */

  /**
   * HTML 转义，防止数据中的特殊字符破坏结构。
   * @param {*} value 待转义的值。
   * @returns {string} 转义后的字符串。
   */
  function esc(value) {
    if (value === null || value === undefined) { return ''; }
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * 判断城市是否包含指定标签。
   * @param {Object} city 城市对象。
   * @param {string} tag 标签名。
   * @returns {boolean} 是否包含。
   */
  function hasTag(city, tag) {
    return !!(city && city.tags && city.tags.indexOf(tag) !== -1);
  }

  /**
   * 根据热度指数获取拥挤等级配置。
   * @param {number} heat 热度指数 0-100。
   * @returns {Object} CROWD_LEVELS 中匹配的配置项。
   */
  function levelOf(heat) {
    for (var i = 0; i < CROWD_LEVELS.length; i++) {
      if (heat >= CROWD_LEVELS[i].min) { return CROWD_LEVELS[i]; }
    }
    return CROWD_LEVELS[CROWD_LEVELS.length - 1];
  }

  /**
   * 16 进制颜色转 RGB 数组。
   * @param {string} hex 形如 '#3aa0ff' 的颜色。
   * @returns {number[]} [r, g, b]。
   */
  function hexToRgb(hex) {
    var v = hex.replace('#', '');
    if (v.length === 3) {
      v = v[0] + v[0] + v[1] + v[1] + v[2] + v[2];
    }
    var num = parseInt(v, 16);
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }

  /**
   * 按 t 混合两个 16 进制颜色。
   * @param {string} c1 起始色。
   * @param {string} c2 结束色。
   * @param {number} t 混合系数 0-1。
   * @returns {string} 混合后的 16 进制颜色。
   */
  function mixColor(c1, c2, t) {
    var a = hexToRgb(c1);
    var b = hexToRgb(c2);
    var r = Math.round(a[0] + (b[0] - a[0]) * t);
    var g = Math.round(a[1] + (b[1] - a[1]) * t);
    var bl = Math.round(a[2] + (b[2] - a[2]) * t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }

  /**
   * 把颜色按比例调暗（用于 hover / 边框）。
   * @param {string} color 'rgb(r,g,b)' 或 '#rrggbb'。
   * @param {number} amount 调暗比例 0-1。
   * @returns {string} 处理后的颜色字符串。
   */
  function darken(color, amount) {
    var rgb = color;
    if (color.charAt(0) === '#') {
      rgb = 'rgb(' + hexToRgb(color).join(',') + ')';
    }
    var parts = rgb.replace(/rgba?\(|\)/g, '').split(',').map(function (n) {
      return Math.max(0, Math.round(parseFloat(n) * (1 - amount)));
    });
    return 'rgb(' + parts[0] + ',' + parts[1] + ',' + parts[2] + ')';
  }

  /**
   * 热度指数 -> 连续色带上的颜色。
   * @param {number} heat 热度指数 0-100。
   * @returns {string} 颜色字符串。
   */
  function heatColor(heat) {
    var ratio = Math.max(0, Math.min(100, heat)) / 100;
    var seg = HEAT_COLORS.length - 1;
    var idx = Math.floor(ratio * seg);
    if (idx >= seg) { return HEAT_COLORS[seg]; }
    return mixColor(HEAT_COLORS[idx], HEAT_COLORS[idx + 1], ratio * seg - idx);
  }

  /**
   * 同比变化的展示文案与样式类。
   * @param {number} delta 同比变化百分点。
   * @returns {{text: string, cls: string}} 展示信息。
   */
  function deltaInfo(delta) {
    if (delta > 0) { return { text: '↑ ' + delta + ' 比去年更挤', cls: 'up' }; }
    if (delta < 0) { return { text: '↓ ' + Math.abs(delta) + ' 比去年更空', cls: 'down' }; }
    return { text: '— 与去年持平', cls: 'flat' };
  }

  /**
   * 通过城市名查找城市对象。
   * @param {string} name 城市名。
   * @returns {Object|null} 城市对象，找不到返回 null。
   */
  function findCity(name) {
    if (!name) { return null; }
    var list = window.CITIES || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === name) { return list[i]; }
    }
    return null;
  }

  /**
   * 获取当前选中的城市对象。
   * @returns {Object|null} 城市对象。
   */
  function getSelectedCity() {
    return findCity(state.selected);
  }

  /**
   * 获取快捷筛选配置。
   * @param {string} key 快捷筛选 key。
   * @returns {Object|null} 配置项。
   */
  function getQuickFilter(key) {
    if (!key) { return null; }
    for (var i = 0; i < QUICK_FILTERS.length; i++) {
      if (QUICK_FILTERS[i].key === key) { return QUICK_FILTERS[i]; }
    }
    return null;
  }

  /* ======================================================================
   * 3. 数据计算（data）
   * ==================================================================== */

  /**
   * 关键词匹配（城市名或省份包含关键词即命中）。
   * @param {Object} city 城市对象。
   * @param {string} keyword 关键词（已 trim）。
   * @returns {boolean} 是否命中。
   */
  /**
   * 取城市的住宿紧张指数样本。
   * ⚠️ 只用「主年份」：HSI 是年内百分位，跨年混排不严谨。
   *    历史年份数据只在详情页作为参考展示。
   * @param {Object} city 城市对象。
   * @returns {Object|null} HSI 记录，无数据返回 null。
   */
  function hsiOf(city) {
    if (!window.HSI || !city) { return null; }
    return window.HSI.primary(city.name);
  }

  /**
   * 取城市在当前指标下的数值。HSI 指标下无样本的城市返回 null（会被过滤掉）。
   * @param {Object} city 城市对象。
   * @returns {number|null} 0-100 的数值。
   */
  function metricOf(city) {
    if (state.metric === 'hsi') {
      var h = hsiOf(city);
      return h ? h.hsi : null;
    }
    return city.heat;
  }

  /**
   * 当前指标的分档色。
   * @param {number} value 0-100 数值。
   * @returns {string} 颜色。
   */
  function metricColor(value) {
    return heatColor(value);
  }

  /**
   * 按当前指标给出分档标签（爆满 / 一房难求 …）。
   * @param {number} value 0-100 数值。
   * @returns {{label: string, color: string, desc: string}} 分档。
   */
  function metricLevel(value) {
    var levels = METRICS[state.metric].levels;
    for (var i = 0; i < levels.length; i++) {
      if (value >= levels[i].min) { return levels[i]; }
    }
    return levels[levels.length - 1];
  }

  function matchKeyword(city, keyword) {
    if (!keyword) { return true; }
    return city.name.indexOf(keyword) !== -1 || city.province.indexOf(keyword) !== -1;
  }

  /**
   * 按当前全部筛选条件过滤城市。
   * @returns {Object[]} 过滤后的城市数组（保持原顺序）。
   */
  function getFilteredCities() {
    var list = window.CITIES || [];
    var keyword = state.keyword.trim();
    var quick = getQuickFilter(state.quick);
    var result = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (state.province !== 'all' && c.province !== state.province) { continue; }
      // HSI 指标下：没有酒店价格样本的城市不参与（地图与榜单一并隐藏，避免出现空值点位）
      if (state.metric === 'hsi') {
        var h = hsiOf(c);
        if (!h) { continue; }
        if (h.hsi < state.heatMin || h.hsi > state.heatMax) { continue; }
      } else if (c.heat < state.heatMin || c.heat > state.heatMax) {
        continue;
      }
      if (quick && !quick.test(c)) { continue; }
      if (!matchKeyword(c, keyword)) { continue; }
      result.push(c);
    }
    return result;
  }

  /**
   * 按省份聚合热度统计（用于省份填充视图）。
   * @param {Object[]} cities 城市数组。
   * @returns {Object} { 省份简称: {count, sum, avg, max, topCity} }。
   */
  function getProvinceStats(cities) {
    var map = {};
    cities.forEach(function (c) {
      if (!map[c.province]) {
        map[c.province] = { count: 0, sum: 0, max: -1, topCity: null };
      }
      var s = map[c.province];
      s.count += 1;
      s.sum += c.heat;
      if (c.heat > s.max) {
        s.max = c.heat;
        s.topCity = c;
      }
    });
    Object.keys(map).forEach(function (key) {
      map[key].avg = Math.round(map[key].sum / map[key].count);
    });
    return map;
  }

  /**
   * 计算当前筛选结果的概览统计。
   * @param {Object[]} cities 城市数组。
   * @returns {{count: number, avg: number, hottest: Object|null, coolest: Object|null}} 统计结果。
   */
  function getSummary(cities) {
    var summary = { count: cities.length, avg: 0, hottest: null, coolest: null };
    // 三峡专题点位（src='official'）的 heat 是占位值，不参与均值与极值统计，
    // 否则会拉偏均值并可能顶替真实的「最挤 / 最舒服」。
    var pool = cities.filter(function (c) { return c.src !== 'official'; });
    if (!pool.length) { return summary; }
    var sum = 0;
    var hottest = pool[0];
    var coolest = pool[0];
    pool.forEach(function (c) {
      sum += c.heat;
      // 热度并列时用原始迁入指数打破平局，保证统计卡与榜单 TOP1 给出同一个城市。
      if (c.heat > hottest.heat
        || (c.heat === hottest.heat && rawValueOf(c) > rawValueOf(hottest))) {
        hottest = c;
      }
      if (c.heat < coolest.heat
        || (c.heat === coolest.heat && rawValueOf(c) < rawValueOf(coolest))) {
        coolest = c;
      }
    });
    summary.avg = Math.round(sum / pool.length);
    summary.hottest = hottest;
    summary.coolest = coolest;
    return summary;
  }

  /** 城市名 -> 原始迁入规模指数的全国排名（1 起），懒加载缓存。 */
  var rawRankMap = null;

  /**
   * 取城市的原始迁入规模指数（缺失时返回 -1，便于排序兜底）。
   * @param {Object} city 城市对象。
   * @returns {number} 原始指数。
   */
  function rawValueOf(city) {
    return (typeof city.raw === 'number' && isFinite(city.raw)) ? city.raw : -1;
  }

  /**
   * 取城市原始迁入规模指数的全国排名（1 起，按原始指数降序）。
   * @param {Object} city 城市对象。
   * @returns {number} 排名，取不到返回 0。
   */
  function rawRankOf(city) {
    if (!rawRankMap) {
      rawRankMap = {};
      var all = (window.CITIES || []).slice().sort(function (a, b) {
        return rawValueOf(b) - rawValueOf(a);
      });
      all.forEach(function (c, i) { rawRankMap[c.name] = i + 1; });
    }
    return rawRankMap[city.name] || 0;
  }

  /**
   * 组装「原始迁入规模指数 · 全国排名」的展示文案。
   * 让 heat 相同的城市（例如都被 p98 截断压到 100 分）也能看出真实先后。
   * @param {Object} city 城市对象。
   * @returns {string} 文案；数据缺失返回空串。
   */
  function rawIndexText(city) {
    if (rawValueOf(city) < 0) { return ''; }
    var rank = rawRankOf(city);
    return city.raw.toFixed(2) + (rank ? '（全国第 ' + rank + '）' : '');
  }

  /**
   * 判断城市是否参与热度榜单排名。
   * 省级汇总口径（数据覆盖有限）的城市默认不参与，避免污染「最挤 / 最舒服」榜单；
   * 地图散点、筛选、搜索、tooltip、详情均不受影响。
   * @param {Object} city 城市对象。
   * @returns {boolean} 是否参与排名。
   */
  function isRankableCity(city) {
    // province = 省级汇总口径（台湾各地）；official = 三峡专题官方假日旅游统计。
    // 两者都与全国迁徙热度指数不可比，因此都不参与热度榜单排名。
    return city.src !== 'province' && city.src !== 'official';
  }

  /**
   * 按热度排序（返回新数组，不修改入参）。
   * @param {Object[]} cities 城市数组。
   * @param {boolean} desc 是否降序（热度高的在前）。
   * @returns {Object[]} 排序后的新数组。
   */
  function sortByHeat(cities, desc) {
    return cities.slice().sort(function (a, b) {
      if (a.heat !== b.heat) { return desc ? b.heat - a.heat : a.heat - b.heat; }
      // heat 相同（如被 p98 截断一并压到 100 分）时改用原始迁入规模指数排序，
      // 保证榜单顺序有真实信息量；仍相同才退回纬度，保持结果稳定。
      var av = rawValueOf(a);
      var bv = rawValueOf(b);
      if (av !== bv) { return desc ? bv - av : av - bv; }
      if (a.lat === b.lat) { return 0; }
      return desc ? b.lat - a.lat : a.lat - b.lat;
    });
  }

  /* ======================================================================
   * 4. 渲染（render）
   * ==================================================================== */

  /**
   * 组装城市 tooltip 的 HTML。
   * @param {Object} city 城市对象。
   * @returns {string} HTML 字符串。
   */
  function cityTooltipHtml(city) {
    // 三峡专题点位没有可比的迁徙热度，改走官方数据专用的展示分支。
    if (city.src === 'official' && city.official) {
      return officialTooltipHtml(city);
    }
    var level = levelOf(city.heat);
    var delta = deltaInfo(city.delta);
    var rawText = rawIndexText(city);
    var tags = (city.tags || []).map(function (t) {
      return '<span class="tt-tag">' + esc(t) + '</span>';
    }).join('');
    return [
      '<div class="tt">',
      '<div class="tt-head">',
      '<span class="tt-name">' + esc(city.name) + '</span>',
      '<span class="tt-badge" style="background:' + level.color + '">' + esc(city.crowd) + '</span>',
      '</div>',
      '<div class="tt-meta">' + esc(city.province) + ' · 建议 ' + esc(city.days) + '</div>',
      '<div class="tt-rows">',
      '<div class="tt-row"><span>国庆热度指数</span><b>' + city.heat + ' / 100</b></div>',
      (rawText ? '<div class="tt-row"><span>原始迁入指数</span><b>' + esc(rawText) + '</b></div>' : ''),
      '<div class="tt-row"><span>拥挤等级</span><b>' + esc(city.crowd) + '</b></div>',
      '<div class="tt-row"><span>同比去年</span><b class="tt-' + delta.cls + '">' + esc(delta.text) + '</b></div>',
      '</div>',
      '<div class="tt-tags">' + tags + '</div>',
      '<div class="tt-reason">' + esc(city.reason) + '</div>',
      (city.src === 'province' ? '<div class="tt-note">' + esc(SRC_PROVINCE_NOTE) + '</div>' : ''),
      '<div class="tt-hint">点击查看详情与实用建议</div>',
      '</div>'
    ].join('');
  }

  /**
   * 组装三峡专题点位的 tooltip：展示官方假日旅游统计与口径，不显示热度指数。
   * @param {Object} city 城市对象（含 official 字段）。
   * @returns {string} HTML 字符串。
   */
  function officialTooltipHtml(city) {
    var o = city.official;
    var tags = (city.tags || []).map(function (t) {
      return '<span class="tt-tag">' + esc(t) + '</span>';
    }).join('');
    return [
      '<div class="tt">',
      '<div class="tt-head">',
      '<span class="tt-name">' + esc(city.name) + '</span>',
      '<span class="tt-badge" style="background:' + OFFICIAL_COLOR + '">三峡专题</span>',
      '</div>',
      '<div class="tt-meta">' + esc(city.province) + ' · 建议 ' + esc(city.days) + '</div>',
      '<div class="tt-rows">',
      '<div class="tt-row"><span>官方接待量</span><b>' + esc(o.value + ' ' + o.unit) + '</b></div>',
      '<div class="tt-row"><span>统计口径</span><b>' + esc(o.caliber) + '</b></div>',
      '<div class="tt-row"><span>同比</span><b>' + esc(o.yoy) + '</b></div>',
      '</div>',
      '<div class="tt-tags">' + tags + '</div>',
      '<div class="tt-reason">' + esc(city.reason) + '</div>',
      '<div class="tt-note">' + esc(SRC_OFFICIAL_NOTE) + '</div>',
      '<div class="tt-hint">点击查看详情与实用建议</div>',
      '</div>'
    ].join('');
  }

  /**
   * 组装省份 tooltip 的 HTML。
   * @param {string} shortName 省份简称。
   * @param {Object} stat 该省份的聚合统计。
   * @returns {string} HTML 字符串。
   */
  function provinceTooltipHtml(shortName, stat) {
    return [
      '<div class="tt">',
      '<div class="tt-title">' + esc(shortName) + '</div>',
      '<div class="tt-rows">',
      '<div class="tt-row"><span>入选目的地</span><b>' + stat.count + ' 个</b></div>',
      '<div class="tt-row"><span>省内最高热度</span><b>' + stat.max + '（' + esc(stat.topCity.name) + '）</b></div>',
      '<div class="tt-row"><span>省内平均热度</span><b>' + stat.avg + '</b></div>',
      '</div>',
      '<div class="tt-hint">点击可只看该省级行政区</div>',
      '</div>'
    ].join('');
  }

  /**
   * 统一的 tooltip formatter，同时处理 geo 区域与散点。
   * @param {Object} params ECharts tooltip 参数。
   * @returns {string} HTML 字符串。
   */
  function tooltipFormatter(params) {
    if (!params) { return ''; }
    if (params.componentType === 'geo') {
      var short = FULL_NAME_TO_SHORT[params.name];
      if (!short) { return ''; }
      var stats = getProvinceStats(getFilteredCities());
      var stat = stats[short];
      if (!stat) {
        return '<div class="tt"><div class="tt-title">' + esc(short) + '</div>' +
          '<div class="tt-line">当前筛选条件下暂无目的地</div></div>';
      }
      return provinceTooltipHtml(short, stat);
    }
    var city = params.data && params.data.city;
    if (!city) { return ''; }
    return cityTooltipHtml(city);
  }

  /**
   * 构建 geo 组件的 regions 配置（省份填充视图下按省内最高热度着色）。
   * @param {Object} stats 省份聚合统计。
   * @returns {Object[]} regions 数组。
   */
  function buildRegions(stats) {
    if (state.view !== 'province') { return []; }
    return PROVINCE_LIST.map(function (shortName) {
      var stat = stats[shortName];
      if (!stat) {
        return { name: PROVINCE_FULL_NAME[shortName], itemStyle: { areaColor: '#eef1f7' } };
      }
      var color = heatColor(stat.max);
      return {
        name: PROVINCE_FULL_NAME[shortName],
        itemStyle: { areaColor: color },
        emphasis: { itemStyle: { areaColor: darken(color, 0.14) } }
      };
    });
  }

  /**
   * 构建 geo 组件配置。
   * @param {Object} stats 省份聚合统计。
   * @returns {Object} geo 配置。
   */
  function buildGeoOption(stats) {
    var geo = {
      map: 'china',
      roam: true,
      zoom: state.mapZoom,
      scaleLimit: { min: 1, max: 12 },
      // 整体缩小 6%，给四周留白，避免最北端（漠河）与最南端散点被容器边缘裁切。
      layoutCenter: ['50%', '50%'],
      layoutSize: '94%',
      selectedMode: false,
      itemStyle: {
        areaColor: '#eef1f7',
        borderColor: '#ffffff',
        borderWidth: 0.8
      },
      emphasis: {
        itemStyle: { areaColor: '#dbe3f0' },
        label: { show: false }
      },
      regions: buildRegions(stats)
    };
    if (state.mapCenter) { geo.center = state.mapCenter; }
    return geo;
  }

  /**
   * 构建 series 配置（两种视图复用同一套散点，仅尺寸不同）。
   * @param {Object[]} cities 当前筛选出的城市。
   * @returns {Object[]} series 数组。
   */
  function buildSeries(cities) {
    var isProvince = state.view === 'province';
    var minSize = isProvince ? 5 : 7;
    var spanSize = isProvince ? 8 : 22;

    // 三峡专题点位（official）没有可比的迁徙热度，单独成一个 series，
    // 这样 visualMap（seriesIndex 0）不会给它们套上热度渐变色。
    var normalData = [];
    var officialData = [];
    cities.forEach(function (c) {
      var v = state.metric === 'hsi' ? (hsiOf(c) ? hsiOf(c).hsi : c.heat) : c.heat;
      var item = { name: c.name, value: [c.lng, c.lat, v], city: c };
      if (c.src === 'official') { officialData.push(item); } else { normalData.push(item); }
    });

    var main = {
      id: 'cityScatter',
      name: '城市热度',
      type: 'scatter',
      coordinateSystem: 'geo',
      data: normalData,
      symbolSize: function (value) {
        return minSize + (value[2] / 100) * spanSize;
      },
      itemStyle: {
        opacity: isProvince ? 0.95 : 0.86,
        borderColor: '#ffffff',
        borderWidth: 1
      },
      emphasis: {
        scale: 1.35,
        itemStyle: { borderColor: '#111827', borderWidth: 2, opacity: 1 }
      },
      zlevel: 2
    };

    var official = {
      id: 'sanxiaScatter',
      name: '三峡专题',
      type: 'scatter',
      coordinateSystem: 'geo',
      data: officialData,
      symbol: 'diamond',
      symbolSize: 14,
      itemStyle: {
        color: OFFICIAL_COLOR,
        opacity: 0.92,
        borderColor: '#ffffff',
        borderWidth: 1.5
      },
      emphasis: {
        scale: 1.35,
        itemStyle: { borderColor: '#111827', borderWidth: 2, opacity: 1 }
      },
      zlevel: 3
    };

    var selected = getSelectedCity();
    var highlightData = [];
    if (selected) {
      highlightData.push({
        name: selected.name,
        value: [selected.lng, selected.lat, selected.heat],
        city: selected
      });
    }

    var highlight = {
      id: 'cityHighlight',
      name: '选中高亮',
      type: 'effectScatter',
      coordinateSystem: 'geo',
      data: highlightData,
      symbolSize: 18,
      rippleEffect: { brushType: 'stroke', scale: 3, period: 3 },
      itemStyle: { color: 'rgba(228, 87, 61, 0.9)' },
      silent: true,
      tooltip: { show: false },
      zlevel: 3
    };

    return [main, official, highlight];
  }

  /**
   * 构建完整的 ECharts option。
   * @returns {Object} option。
   */
  function buildChartOption() {
    var cities = getFilteredCities();
    var stats = getProvinceStats(cities);
    return {
      backgroundColor: 'transparent',
      animation: true,
      animationDuration: 400,
      animationDurationUpdate: 420,
      animationEasingUpdate: 'cubicOut',
      textStyle: { fontFamily: '"PingFang SC","Microsoft YaHei",sans-serif' },
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(255, 255, 255, 0.97)',
        borderColor: '#e6e8ee',
        borderWidth: 1,
        padding: [10, 12],
        extraCssText: 'box-shadow:0 12px 32px rgba(16,24,40,.14);border-radius:12px;',
        formatter: tooltipFormatter
      },
      visualMap: {
        type: 'continuous',
        seriesIndex: 0,
        dimension: 2,
        min: 0,
        max: 100,
        left: 14,
        bottom: 18,
        orient: 'vertical',
        itemWidth: 12,
        itemHeight: 116,
        calculable: false,
        text: METRICS[state.metric].text,
        textGap: 8,
        textStyle: { color: '#6b7280', fontSize: 11 },
        inRange: { color: METRICS[state.metric].colors },
        formatter: function (value) { return String(Math.round(value)); }
      },
      geo: buildGeoOption(stats),
      series: buildSeries(cities)
    };
  }

  /**
   * 构建「量价四象限」散点图：横轴客流强度、纵轴住宿紧张度。
   * 两个维度交叉后能区分出「人多」与「房贵」这两种完全不同的拥挤——
   * 例如深圳客流很大但房价平稳，阳朔客流不大却一房难求。
   * @returns {Object} option。
   */
  function buildQuadrantOption() {
    var rows = [];
    var withHsi = 0;
    (window.CITIES || []).forEach(function (c) {
      if (c.src === 'official') { return; }
      if (state.province !== 'all' && c.province !== state.province) { return; }
      var h = hsiOf(c);
      if (!h || h.hsi == null) { return; }
      withHsi += 1;
      rows.push({ name: c.name, value: [c.heat, h.hsi], city: c, hsi: h });
    });

    var year = window.HSI ? window.HSI.primaryYear : '';
    return {
      backgroundColor: 'transparent',
      textStyle: { fontFamily: '"PingFang SC","Microsoft YaHei",sans-serif' },
      title: {
        text: '客流强度 × 住宿紧张度（' + year + ' 年样本 ' + withHsi + ' 城）',
        subtext: '横轴＝国庆热度指数（有多少人去）　纵轴＝HSI（住宿有多紧张）　点击圆点查看详情',
        left: 'center',
        top: 6,
        textStyle: { fontSize: 13, color: '#374151', fontWeight: 500 },
        subtextStyle: { fontSize: 11, color: '#6b7280' }
      },
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(255,255,255,0.97)',
        borderColor: '#e6e8ee',
        borderWidth: 1,
        padding: [10, 12],
        extraCssText: 'box-shadow:0 12px 32px rgba(16,24,40,.14);border-radius:12px;',
        formatter: function (p) {
          var c = p.data.city;
          var h = p.data.hsi;
          var hl = metricLevel(h.hsi);
          return '<div style="font-size:13px;font-weight:600;color:#111827;margin-bottom:4px">'
            + esc(c.name) + ' <span style="color:#6b7280;font-weight:400">' + esc(c.province) + '</span></div>'
            + '<div style="font-size:12px;color:#4b5563;line-height:1.7">'
            + '客流强度 <b>' + c.heat + '</b> / 100<br />'
            + '住宿紧张度 <b style="color:' + hl.color + '">' + h.hsi + '</b> / 100 · ' + esc(hl.label) + '<br />'
            + esc(h.hotel) + '：¥' + h.p0 + ' → ¥' + h.p1 + '（+' + h.pct + '%）</div>';
        }
      },
      grid: { left: 58, right: 30, top: 62, bottom: 52 },
      xAxis: {
        type: 'value', min: 0, max: 100,
        name: '迁徙客流强度 →', nameLocation: 'middle', nameGap: 28,
        nameTextStyle: { color: '#6b7280', fontSize: 12 },
        axisLine: { lineStyle: { color: '#d1d5db' } },
        splitLine: { lineStyle: { color: '#f1f3f8' } }
      },
      yAxis: {
        type: 'value', min: 0, max: 100,
        name: '住宿紧张度 HSI →', nameLocation: 'middle', nameGap: 40,
        nameTextStyle: { color: '#6b7280', fontSize: 12 },
        axisLine: { lineStyle: { color: '#d1d5db' } },
        splitLine: { lineStyle: { color: '#f1f3f8' } }
      },
      series: [
        {
          id: 'quadrant',
          type: 'scatter',
          data: rows,
          symbolSize: 13,
          itemStyle: {
            color: function (p) { return metricLevel(p.data.value[1]).color; },
            opacity: 0.86, borderColor: '#ffffff', borderWidth: 1
          },
          emphasis: { scale: 1.4, itemStyle: { borderColor: '#111827', borderWidth: 2, opacity: 1 } },
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { color: '#c9cedb', type: 'dashed', width: 1 },
            label: { show: false },
            data: [{ xAxis: 50 }, { yAxis: 50 }]
          }
        }
      ],
      graphic: [
        { type: 'text', left: 74, top: 74, style: { text: '小众爆满 · 房源紧俏', fill: '#993C1D', fontSize: 12 } },
        { type: 'text', right: 44, top: 74, style: { text: '顶流热门 · 人财两旺', fill: '#993C1D', fontSize: 12 } },
        { type: 'text', left: 74, bottom: 64, style: { text: '真正冷清 · 量价皆平', fill: '#888780', fontSize: 12 } },
        { type: 'text', right: 44, bottom: 64, style: { text: '承载力强 · 量大价稳', fill: '#185FA5', fontSize: 12 } }
      ]
    };
  }

  /**
   * 渲染 / 更新地图（不重建实例，视图切换时使用 notMerge 清理旧组件）。
   * @returns {void}
   */
  function renderChart() {
    if (!chart) { return; }
    var option = state.view === 'quadrant' ? buildQuadrantOption() : buildChartOption();
    if (lastView === state.view) {
      chart.setOption(option);
    } else {
      // 四象限是直角坐标系、地图是 geo 坐标系，两者组件完全不同，必须整体替换
      chart.setOption(option, true);
      lastView = state.view;
    }
  }

  /**
   * 渲染顶部统计概览。
   * @param {Object} summary 统计结果。
   * @returns {void}
   */
  function renderStats(summary) {
    var hot = summary.hottest;
    var cool = summary.coolest;
    el.topStats.innerHTML = [
      '<div class="stat"><div class="stat-k">筛选结果</div>',
      '<div class="stat-v">' + summary.count + '<small>个目的地</small></div></div>',
      '<div class="stat"><div class="stat-k">平均热度</div>',
      '<div class="stat-v">' + summary.avg + '<small>/ 100</small></div></div>',
      '<div class="stat"><div class="stat-k">最挤</div>',
      '<div class="stat-v">' + (hot ? esc(hot.name) + '<small>' + hot.heat + '</small>' : '—') + '</div></div>',
      '<div class="stat"><div class="stat-k">最舒服</div>',
      '<div class="stat-v">' + (cool ? esc(cool.name) + '<small>' + cool.heat + '</small>' : '—') + '</div></div>'
    ].join('');
  }

  /**
   * 渲染地图下方的图例（连续色带 + 五档拥挤等级及其数量）。
   * @param {Object[]} cities 当前筛选出的城市。
   * @returns {void}
   */
  function renderLegend(cities) {
    var levels = METRICS[state.metric].levels;
    var counts = {};
    levels.forEach(function (lv) { counts[lv.label] = 0; });
    cities.forEach(function (c) {
      var v = state.metric === 'hsi' ? (hsiOf(c) ? hsiOf(c).hsi : null) : c.heat;
      if (v == null) { return; }
      counts[metricLevel(v).label] = (counts[metricLevel(v).label] || 0) + 1;
    });

    var chips = levels.map(function (lv) {
      return '<span class="legend-level">' +
        '<i class="legend-dot" style="background:' + lv.color + '"></i>' +
        esc(lv.label) + ' <b>' + (counts[lv.label] || 0) + '</b></span>';
    }).join('');

    var isHsi = state.metric === 'hsi';
    var scale = isHsi
      ? '<div class="legend-scale"><span>0 价格洼地</span><span>100 一房难求</span></div>'
      : '<div class="legend-scale"><span>0 冷清</span><span>100 爆满</span></div>';

    el.mapLegend.innerHTML = [
      '<div class="legend-block">',
      '<div class="legend-bar"></div>',
      scale,
      '</div>',
      '<div class="legend-levels">' + chips + '</div>',
      isHsi ? '<div class="legend-note">' + esc(HSI_NOTE) + '</div>' : ''
    ].join('');
  }

  /**
   * 渲染右侧排行榜。
   * @param {Object[]} cities 当前筛选出的城市。
   * @returns {void}
   */
  function renderRank(cities) {
    var desc = state.rankMode === 'hot';
    var isHsi = state.metric === 'hsi';
    // 省级汇总口径的城市默认不进榜单；只有当筛选结果里「只剩下」这类城市时
    //（例如省份筛选选了台湾省）才回退为展示它们，并附一行口径提示，避免榜单空白。
    // HSI 指标下改为「没有酒店价格样本的城市不进榜单」。
    var pool = cities.filter(function (c) { return isHsi ? !!hsiOf(c) : isRankableCity(c); });
    var fallback = !pool.length;
    if (fallback) { pool = cities.slice(); }
    var val = function (c) { return isHsi ? hsiOf(c).hsi : c.heat; };
    var top = isHsi
      ? pool.slice().sort(function (a, b) { return desc ? val(b) - val(a) : val(a) - val(b); }).slice(0, RANK_SIZE)
      : sortByHeat(pool, desc).slice(0, RANK_SIZE);
    if (!top.length) {
      el.rankList.innerHTML = '<li class="rank-empty">当前筛选条件下没有匹配的目的地</li>';
      return;
    }
    var note = isHsi
      ? '<li class="rank-note">' + esc(HSI_NOTE) + '</li>'
      : (fallback ? '<li class="rank-note">' + esc(SRC_PROVINCE_NOTE) + '</li>' : '');
    el.rankList.innerHTML = note + top.map(function (c, i) {
      var v = isHsi ? hsiOf(c).hsi : c.heat;
      var color = metricColor(v);
      var sub = isHsi ? (c.province + ' · ' + metricLevel(v).label) : (c.province + ' · ' + c.crowd);
      var active = c.name === state.selected ? ' is-active' : '';
      return [
        '<li class="rank-item' + active + '" data-name="' + esc(c.name) + '">',
        '<span class="rank-no">' + (i + 1) + '</span>',
        '<span class="rank-main">',
        '<span class="rank-name">' + esc(c.name) + '<em>' + esc(sub) + '</em></span>',
        '<span class="rank-bar"><i style="width:' + v + '%;background:' + color + '"></i></span>',
        '</span>',
        '<span class="rank-heat" style="color:' + color + '">' + (Math.round(v * 10) / 10) + '</span>',
        '</li>'
      ].join('');
    }).join('');
  }

  /**
   * 渲染右侧详情卡片。
   * @returns {void}
   */
  function renderDetail() {
    var city = getSelectedCity();
    if (!city) {
      el.detail.innerHTML = [
        '<div class="detail-empty">还没选择目的地<br />',
        '在地图上点击任意城市气泡，<br />或从上方热度榜里挑一个</div>'
      ].join('');
      return;
    }
    var isOfficial = city.src === 'official' && !!city.official;
    var level = levelOf(city.heat);
    var delta = deltaInfo(city.delta);
    var rawText = rawIndexText(city);
    var tags = (city.tags || []).map(function (t) {
      return '<span class="tag">' + esc(t) + '</span>';
    }).join('');
    var spots = (city.spots || []).map(function (s) {
      return '<span class="tag-spot">' + esc(s) + '</span>';
    }).join('');

    // 三峡专题：展示官方接待量与口径，不显示不可比的热度指数。
    var scoreBlock = isOfficial
      ? [
        '<div class="detail-score">',
        '<span class="ds-num" style="color:' + OFFICIAL_COLOR + '">' + esc(city.official.value) + '</span>',
        '<span class="ds-unit">' + esc(city.official.unit) + '<br />' + esc(city.official.caliber) + '</span>',
        '<span class="ds-delta">' + esc(city.official.yoy) + '</span>',
        '</div>'
      ].join('')
      : [
        '<div class="detail-score">',
        '<span class="ds-num" style="color:' + level.color + '">' + city.heat + '</span>',
        '<span class="ds-unit">国庆热度指数<br />越高越挤</span>',
        '<span class="ds-delta ' + delta.cls + '">' + esc(delta.text) + '</span>',
        '</div>'
      ].join('');

    var noteBlock = isOfficial
      ? '<div class="detail-note">' + esc(SRC_OFFICIAL_NOTE) + '</div>'
      : (city.src === 'province' ? '<div class="detail-note">' + esc(SRC_PROVINCE_NOTE) + '</div>' : '');

    var officialBlock = isOfficial
      ? '<div class="detail-label">官方数据明细</div>'
        + '<div class="detail-text">' + esc(city.official.detail) + '</div>'
        + '<div class="detail-meta">数据来源：' + esc(city.official.source) + '（2025 年国庆假日统计）</div>'
      : (rawText ? '<div class="detail-meta">原始迁入规模指数 ' + esc(rawText) + '（热度由该指数归一化换算）</div>' : '');

    // 住宿紧张度（HSI）：有酒店价格样本就展示，与热度指数并列呈现，便于「量 vs 价」对照。
    var hsiBlock = '';
    var hRec = hsiOf(city);
    if (hRec && !isOfficial && hRec.hsi != null) {
      var hl = metricLevel(hRec.hsi);
      var ym = (window.HSI.yearMeta && window.HSI.yearMeta[hRec.y]) || {};
      hsiBlock = [
        '<div class="detail-label">住宿紧张度 HSI · ' + hRec.y + '</div>',
        '<div class="detail-text">',
        '<b style="color:' + hl.color + '">' + hRec.hsi + ' / 100 · ' + esc(hl.label) + '</b><br />',
        esc(hRec.hotel) + '：平日 ¥' + hRec.p0 + ' → 假期 ¥' + hRec.p1 + '，',
        '涨幅 <b>' + hRec.pct + '%</b>（约 ' + (Math.round(hRec.raw * 10) / 10) + ' 倍）',
        '</div>',
        '<div class="detail-meta">' + esc(HSI_NOTE) + '</div>',
        '<div class="detail-meta">样本口径：' + esc(ym.brand || '—') + '　'
          + esc(ym.baseline || '') + (ym.holiday ? ' vs ' + esc(ym.holiday) : '') + '　来源：' + esc(ym.source || '—') + '</div>'
      ].join('');

      // 历史年份样本：口径不同，只作参考，明确标注不可与主年份直接比较
      var hist = window.HSI.historyOf ? window.HSI.historyOf(city.name) : [];
      if (hist.length) {
        hsiBlock += '<div class="detail-meta">历史参考（口径不同，不与 ' + hRec.y + ' 年直接比较）：'
          + hist.map(function (r) {
            return r.y + ' 年 HSI ' + r.hsi + '（' + esc(r.hotel) + ' ¥' + r.p0 + '→¥' + r.p1 + '，+' + r.pct + '%）';
          }).join('　|　')
          + '</div>';
      }
    }

    el.detail.innerHTML = [
      '<div class="detail-head">',
      '<span class="detail-name">' + esc(city.name) + '</span>',
      isOfficial
        ? '<span class="detail-badge" style="background:' + OFFICIAL_COLOR + '">三峡专题</span>'
        : '<span class="detail-badge" style="background:' + level.color + '">' + esc(city.crowd) + '</span>',
      '</div>',
      '<div class="detail-meta">' + esc(city.province) + ' · 建议 ' + esc(city.days) + ' · '
        + (isOfficial ? '官方假日统计口径' : esc(level.desc)) + '</div>',
      scoreBlock,
      noteBlock,
      officialBlock,
      hsiBlock,
      '<div class="detail-tags">' + tags + '</div>',
      '<div class="detail-label">国庆体验</div>',
      '<div class="detail-text">' + esc(city.reason) + '</div>',
      '<div class="detail-label">实用建议</div>',
      '<div class="detail-text">' + esc(city.tip) + '</div>',
      '<div class="detail-label">代表景点</div>',
      '<div class="detail-tags">' + spots + '</div>',
      '<div class="detail-actions">',
      '<button class="ghost-btn" type="button" id="btn-locate">地图定位</button>',
      '<button class="ghost-btn" type="button" id="btn-only-province">只看' + esc(city.province) + '</button>',
      '</div>'
    ].join('');

    var btnLocate = document.getElementById('btn-locate');
    var btnProvince = document.getElementById('btn-only-province');
    if (btnLocate) {
      btnLocate.addEventListener('click', function () {
        focusCity(city);
      });
    }
    if (btnProvince) {
      btnProvince.addEventListener('click', function () {
        state.province = city.province;
        if (provinceCenter[state.province]) {
          state.mapCenter = provinceCenter[state.province];
          state.mapZoom = PROVINCE_ZOOM;
        }
        renderAll();
      });
    }
  }

  /**
   * 同步左侧控件的显示状态（省份下拉、滑块、快捷标签、视图按钮）。
   * @returns {void}
   */
  function renderControls() {
    el.provinceSelect.value = state.province;
    el.heatMin.value = String(state.heatMin);
    el.heatMax.value = String(state.heatMax);
    el.heatMinVal.textContent = String(state.heatMin);
    el.heatMaxVal.textContent = String(state.heatMax);
    el.heatVal.textContent = state.heatMin + ' - ' + state.heatMax;
    el.searchInput.value = state.keyword;
    el.searchClear.classList.toggle('is-show', state.keyword.length > 0);

    Array.prototype.forEach.call(el.presetRow.querySelectorAll('.chip'), function (btn) {
      var min = Number(btn.getAttribute('data-min'));
      var max = Number(btn.getAttribute('data-max'));
      btn.classList.toggle('is-active', min === state.heatMin && max === state.heatMax);
    });

    Array.prototype.forEach.call(el.quickRow.querySelectorAll('.chip'), function (btn) {
      btn.classList.toggle('is-active', btn.getAttribute('data-key') === state.quick);
    });

    Array.prototype.forEach.call(el.viewSwitch.querySelectorAll('.seg-btn'), function (btn) {
      var on = btn.getAttribute('data-view') === state.view;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });

    Array.prototype.forEach.call(el.rankTabs.querySelectorAll('.seg-btn'), function (btn) {
      btn.classList.toggle('is-active', btn.getAttribute('data-mode') === state.rankMode);
    });

    if (el.metricSwitch) {
      Array.prototype.forEach.call(el.metricSwitch.querySelectorAll('.seg-btn'), function (btn) {
        var on = btn.getAttribute('data-metric') === state.metric;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
        // 四象限视图同时用到两个指标，此时两个按钮都高亮
        if (state.view === 'quadrant') { btn.classList.add('is-active'); }
      });
    }

    if (el.metricHint) {
      el.metricHint.textContent = state.view === 'quadrant'
        ? '横轴＝客流强度，纵轴＝住宿紧张度，点击圆点看详情'
        : METRICS[state.metric].desc;
    }

    el.mapTitle.textContent = state.view === 'quadrant'
      ? '量价四象限'
      : (state.view === 'province'
        ? '省份热度填充'
        : (state.metric === 'hsi' ? '住宿紧张度气泡' : '城市热度气泡'));
  }

  /**
   * 渲染搜索联想下拉。
   * @returns {void}
   */
  function renderSuggest() {
    var keyword = state.keyword.trim();
    if (!keyword) {
      el.suggest.hidden = true;
      el.suggest.innerHTML = '';
      return;
    }
    var list = (window.CITIES || []).filter(function (c) {
      return matchKeyword(c, keyword);
    }).slice(0, 8);

    if (!list.length) {
      el.suggest.innerHTML = '<li class="suggest-empty">没有找到匹配的城市</li>';
      el.suggest.hidden = false;
      return;
    }

    el.suggest.innerHTML = list.map(function (c) {
      return '<li class="suggest-item" data-name="' + esc(c.name) + '">' +
        '<span>' + esc(c.name) + '<span class="sg-prov"> · ' + esc(c.province) + '</span></span>' +
        '<span class="rank-heat" style="color:' + heatColor(c.heat) + '">' + c.heat + '</span>' +
        '</li>';
    }).join('');
    el.suggest.hidden = false;
  }

  /**
   * 一次完整的重绘（控件 + 地图 + 统计 + 图例 + 排行榜 + 详情）。
   * @returns {void}
   */
  function renderAll() {
    var cities = getFilteredCities();
    var summary = getSummary(cities);
    renderControls();
    renderStats(summary);
    renderLegend(cities);
    renderChart();
    renderRank(cities);
    renderDetail();
  }

  /**
   * 定位到某个城市：设为选中态、地图居中并放大、打开详情。
   * @param {Object} city 城市对象。
   * @returns {void}
   */
  function focusCity(city) {
    if (!city) { return; }
    state.selected = city.name;
    state.mapCenter = [city.lng, city.lat];
    state.mapZoom = state.view === 'province' ? FOCUS_ZOOM_PROVINCE : FOCUS_ZOOM;
    renderAll();
  }

  /**
   * 通过搜索结果定位城市。
   * 若该城市被当前筛选条件排除，则自动放宽筛选条件，保证「搜到就一定能看到」。
   * @param {Object} city 城市对象。
   * @returns {void}
   */
  function focusCityFromSearch(city) {
    if (!city) { return; }
    var visible = getFilteredCities().some(function (c) { return c.name === city.name; });
    if (!visible) {
      state.heatMin = 0;
      state.heatMax = 100;
      state.quick = '';
      if (state.province !== 'all' && state.province !== city.province) {
        state.province = 'all';
      }
    }
    focusCity(city);
  }

  /* ======================================================================
   * 5. 事件绑定（events）
   * ==================================================================== */

  /**
   * 选中某个城市（仅更新选中态与详情，不改变地图视野）。
   * @param {string} name 城市名。
   * @returns {void}
   */
  function selectCity(name) {
    state.selected = name;
    renderChart();
    renderRank(getFilteredCities());
    renderDetail();
  }

  /**
   * 地图漫游后同步当前 center / zoom，避免后续 setOption 把视野拉回。
   * @returns {void}
   */
  function syncRoam() {
    if (!chart) { return; }
    var option = chart.getOption();
    if (option && option.geo && option.geo[0]) {
      state.mapCenter = option.geo[0].center || null;
      state.mapZoom = option.geo[0].zoom || DEFAULT_ZOOM;
    }
  }

  /**
   * 绑定全部 DOM 事件。
   * @returns {void}
   */
  function bindEvents() {
    // ---- 视图切换 ----
    el.viewSwitch.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.seg-btn');
      if (!btn) { return; }
      state.view = btn.getAttribute('data-view');
      renderAll();
    });

    // ---- 指标切换（国庆热度 / 住宿紧张度）----
    if (el.metricSwitch) {
      el.metricSwitch.addEventListener('click', function (ev) {
        var btn = ev.target.closest('.seg-btn');
        if (!btn) { return; }
        state.metric = btn.getAttribute('data-metric');
        if (state.view === 'quadrant') { state.view = 'scatter'; }
        renderAll();
      });
    }

    // ---- 排行榜模式切换 ----
    el.rankTabs.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.seg-btn');
      if (!btn) { return; }
      state.rankMode = btn.getAttribute('data-mode');
      renderControls();
      renderRank(getFilteredCities());
    });

    // ---- 排行榜条目点击：定位 + 打开详情 ----
    el.rankList.addEventListener('click', function (ev) {
      var item = ev.target.closest('.rank-item');
      if (!item) { return; }
      focusCity(findCity(item.getAttribute('data-name')));
    });

    // ---- 省份下拉 ----
    el.provinceSelect.addEventListener('change', function () {
      state.province = el.provinceSelect.value;
      if (state.province !== 'all' && provinceCenter[state.province]) {
        state.mapCenter = provinceCenter[state.province];
        state.mapZoom = PROVINCE_ZOOM;
      }
      renderAll();
    });

    // ---- 热度区间双滑块 ----
    el.heatMin.addEventListener('input', function () {
      var value = Math.min(Number(el.heatMin.value), state.heatMax);
      state.heatMin = value;
      renderAll();
    });
    el.heatMax.addEventListener('input', function () {
      var value = Math.max(Number(el.heatMax.value), state.heatMin);
      state.heatMax = value;
      renderAll();
    });

    // ---- 热度区间快捷档位 ----
    el.presetRow.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.chip');
      if (!btn) { return; }
      var min = Number(btn.getAttribute('data-min'));
      var max = Number(btn.getAttribute('data-max'));
      if (state.heatMin === min && state.heatMax === max) {
        state.heatMin = 0;
        state.heatMax = 100;
      } else {
        state.heatMin = min;
        state.heatMax = max;
      }
      renderAll();
    });

    // ---- 快捷标签筛选 ----
    el.quickRow.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.chip');
      if (!btn) { return; }
      var key = btn.getAttribute('data-key');
      state.quick = state.quick === key ? '' : key;
      renderAll();
    });

    // ---- 搜索输入 ----
    el.searchInput.addEventListener('input', function () {
      state.keyword = el.searchInput.value;
      renderControls();
      renderSuggest();
      renderChart();
      renderStats(getSummary(getFilteredCities()));
      renderLegend(getFilteredCities());
      renderRank(getFilteredCities());
    });

    el.searchInput.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') { return; }
      ev.preventDefault();
      var first = el.suggest.querySelector('.suggest-item');
      if (first) {
        focusCityFromSearch(findCity(first.getAttribute('data-name')));
      } else {
        var list = getFilteredCities();
        if (list.length === 1) { focusCityFromSearch(list[0]); }
      }
      el.suggest.hidden = true;
      el.searchInput.blur();
    });

    el.searchInput.addEventListener('focus', function () {
      if (state.keyword.trim()) { renderSuggest(); }
    });

    document.addEventListener('click', function (ev) {
      if (!el.suggest.hidden && !el.searchBox.contains(ev.target)) {
        el.suggest.hidden = true;
      }
    });

    // ---- 联想条目点击 ----
    el.suggest.addEventListener('click', function (ev) {
      var item = ev.target.closest('.suggest-item');
      if (!item) { return; }
      focusCityFromSearch(findCity(item.getAttribute('data-name')));
      el.suggest.hidden = true;
    });

    // ---- 清空搜索 ----
    el.searchClear.addEventListener('click', function () {
      state.keyword = '';
      el.searchInput.value = '';
      el.searchInput.focus();
      renderAll();
    });

    // ---- 重置全部筛选 ----
    el.resetFilter.addEventListener('click', function () {
      state.province = 'all';
      state.heatMin = 0;
      state.heatMax = 100;
      state.keyword = '';
      state.quick = '';
      el.searchInput.value = '';
      el.suggest.hidden = true;
      renderAll();
    });

    // ---- 缩放复位 ----
    el.zoomReset.addEventListener('click', function () {
      state.mapCenter = null;
      state.mapZoom = DEFAULT_ZOOM;
      renderChart();
    });

    // ---- 地图交互 ----
    chart.on('click', function (params) {
      if (params.componentType === 'geo') {
        var short = FULL_NAME_TO_SHORT[params.name];
        if (!short) { return; }
        state.province = state.province === short ? 'all' : short;
        if (state.province !== 'all' && provinceCenter[short]) {
          state.mapCenter = provinceCenter[short];
          state.mapZoom = PROVINCE_ZOOM;
        }
        renderAll();
        return;
      }
      var city = params.data && params.data.city;
      if (city) { selectCity(city.name); }
    });

    chart.on('georoam', syncRoam);

    // ---- 窗口尺寸变化 ----
    window.addEventListener('resize', function () {
      if (chart) { chart.resize(); }
    });
  }

  /* ======================================================================
   * 6. 初始化（init）
   * ==================================================================== */

  /**
   * 缓存 DOM 节点引用。
   * @returns {void}
   */
  function cacheElements() {
    el.topStats = document.getElementById('top-stats');
    el.mapTitle = document.getElementById('map-title');
    el.mapLegend = document.getElementById('map-legend');
    el.viewSwitch = document.getElementById('view-switch');
  el.metricSwitch = document.getElementById('metric-switch');
  el.metricHint = document.getElementById('metric-hint');
    el.zoomReset = document.getElementById('btn-zoom-reset');
    el.provinceSelect = document.getElementById('province-select');
    el.heatMin = document.getElementById('heat-min');
    el.heatMax = document.getElementById('heat-max');
    el.heatMinVal = document.getElementById('heat-min-val');
    el.heatMaxVal = document.getElementById('heat-max-val');
    el.heatVal = document.getElementById('heat-val');
    el.presetRow = document.getElementById('preset-row');
    el.quickRow = document.getElementById('quick-row');
    el.resetFilter = document.getElementById('btn-reset-filter');
    el.searchBox = document.querySelector('.search-box');
    el.searchInput = document.getElementById('search-input');
    el.searchClear = document.getElementById('btn-clear-search');
    el.suggest = document.getElementById('search-suggest');
    el.rankTabs = document.getElementById('rank-tabs');
    el.rankList = document.getElementById('rank-list');
    el.detail = document.getElementById('detail');
  }

  /**
   * 构建省份下拉选项与省份中心点索引。
   * @returns {void}
   */
  function buildProvinceIndex() {
    var html = ['<option value="all">全部省级行政区</option>'];
    PROVINCE_LIST.forEach(function (shortName) {
      var full = PROVINCE_FULL_NAME[shortName];
      FULL_NAME_TO_SHORT[full] = shortName;
      html.push('<option value="' + esc(shortName) + '">' + esc(shortName) + '</option>');
    });
    el.provinceSelect.innerHTML = html.join('');

    var features = (window.CHINA_GEO && window.CHINA_GEO.features) || [];
    features.forEach(function (feature) {
      var short = FULL_NAME_TO_SHORT[feature.properties.name];
      var center = feature.properties.center;
      if (short && Array.isArray(center) && center.length >= 2) {
        provinceCenter[short] = [center[0], center[1]];
      }
    });
  }

  /**
   * 构建快捷筛选按钮。
   * @returns {void}
   */
  function buildQuickFilters() {
    el.quickRow.innerHTML = QUICK_FILTERS.map(function (item) {
      return '<button class="chip" type="button" data-key="' + esc(item.key) + '">' +
        esc(item.label) + '</button>';
    }).join('');
  }

  /**
   * 入口：注册地图、初始化图表、绑定事件、首次渲染。
   * @returns {void}
   */
  function init() {
    cacheElements();

    if (typeof echarts === 'undefined') {
      el.detail.innerHTML = '<div class="detail-empty">未能加载 assets/echarts.min.js，请确认文件存在。</div>';
      return;
    }
    if (!window.CHINA_GEO) {
      el.detail.innerHTML = '<div class="detail-empty">未能加载 data/geo.js，请先执行 node tools/build-geo.js。</div>';
      return;
    }
    if (!window.CITIES || !window.CITIES.length) {
      el.detail.innerHTML = '<div class="detail-empty">未能加载 data/cities.js，请确认文件存在。</div>';
      return;
    }

    echarts.registerMap('china', window.CHINA_GEO);

    buildProvinceIndex();
    buildQuickFilters();

    chart = echarts.init(document.getElementById('map'));
    renderChart();
    lastView = state.view;

    bindEvents();
    renderAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
