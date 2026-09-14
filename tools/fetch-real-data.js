/* eslint-disable no-console */
/**
 * tools/fetch-real-data.js —— 接入真实数据源，重建 data/cities.js
 *
 * 数据源
 *   1) 行政区划 / 城市清单 / 经纬度：阿里云 DataV.GeoAtlas
 *      GET https://geo.datav.aliyun.com/areas_v3/bound/{省adcode}_full.json
 *   2) 真实人流热度：百度迁徙（百度地图慧眼）迁入规模指数
 *      GET https://huiyan.baidu.com/migration/historycurve.jsonp?dt=city&id={adcode}&type=move_in
 *
 * 产出
 *   data/cities.js（window.CITIES 全局变量形式，纯静态、file:// 可直接打开）
 *
 * 特性
 *   - 本地缓存：原始响应落在 data/.cache/，已缓存不再请求，支持断点续传 / 反复重跑
 *   - 控频：请求间隔 >= REQ_INTERVAL 毫秒
 *   - 失败重试：单城市最多 MAX_RETRY 次，仍失败进失败清单
 *   - 人工文案复用：data/cities.js 里手写的 tags/reason/tip/days/spots 按城市名匹配保留；
 *     首次运行时会把文案备份到 tools/legacy-city-copy.json，之后重跑也丢不了
 *
 * 用法
 *   node tools/fetch-real-data.js            正常跑（走缓存）
 *   node tools/fetch-real-data.js --force    忽略百度缓存，重新抓取
 *   node tools/fetch-real-data.js --dry      只跑城市清单，不抓百度（调试用）
 */
'use strict';

const fs = require('fs');
const path = require('path');
/** 仅使用 Node 内置模块，零第三方依赖。 */
const httpsMod = require('https');

/* ======================================================================
 * 0. 常量配置
 * ==================================================================== */

const ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data', '.cache');
const OUT_FILE = path.join(ROOT, 'data', 'cities.js');
const LEGACY_COPY_FILE = path.join(__dirname, 'legacy-city-copy.json');

/** 浏览器 UA，百度迁徙会校验。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 请求间隔（毫秒），控频避免被限流。 */
const REQ_INTERVAL = 350;
/** 单城市失败重试次数。 */
const MAX_RETRY = 2;
/** 单请求超时（毫秒）。 */
const REQ_TIMEOUT = 20000;

/** 统计窗口：2025 国庆 7 天 / 2024 国庆 7 天。 */
const RANGE_2025 = ['20251001', '20251002', '20251003', '20251004', '20251005', '20251006', '20251007'];
const RANGE_2024 = ['20241001', '20241002', '20241003', '20241004', '20241005', '20241006', '20241007'];

/** 34 个省级行政区：adcode / 全称 / 简称。 */
const PROVINCES = [
  { code: '110000', full: '北京市', short: '北京', direct: true },
  { code: '120000', full: '天津市', short: '天津', direct: true },
  { code: '130000', full: '河北省', short: '河北' },
  { code: '140000', full: '山西省', short: '山西' },
  { code: '150000', full: '内蒙古自治区', short: '内蒙古' },
  { code: '210000', full: '辽宁省', short: '辽宁' },
  { code: '220000', full: '吉林省', short: '吉林' },
  { code: '230000', full: '黑龙江省', short: '黑龙江' },
  { code: '310000', full: '上海市', short: '上海', direct: true },
  { code: '320000', full: '江苏省', short: '江苏' },
  { code: '330000', full: '浙江省', short: '浙江' },
  { code: '340000', full: '安徽省', short: '安徽' },
  { code: '350000', full: '福建省', short: '福建' },
  { code: '360000', full: '江西省', short: '江西' },
  { code: '370000', full: '山东省', short: '山东' },
  { code: '410000', full: '河南省', short: '河南' },
  { code: '420000', full: '湖北省', short: '湖北' },
  { code: '430000', full: '湖南省', short: '湖南' },
  { code: '440000', full: '广东省', short: '广东' },
  { code: '450000', full: '广西壮族自治区', short: '广西' },
  { code: '460000', full: '海南省', short: '海南' },
  { code: '500000', full: '重庆市', short: '重庆', direct: true },
  { code: '510000', full: '四川省', short: '四川' },
  { code: '520000', full: '贵州省', short: '贵州' },
  { code: '530000', full: '云南省', short: '云南' },
  { code: '540000', full: '西藏自治区', short: '西藏' },
  { code: '610000', full: '陕西省', short: '陕西' },
  { code: '620000', full: '甘肃省', short: '甘肃' },
  { code: '630000', full: '青海省', short: '青海' },
  { code: '640000', full: '宁夏回族自治区', short: '宁夏' },
  { code: '650000', full: '新疆维吾尔自治区', short: '新疆' },
  { code: '710000', full: '台湾省', short: '台湾', fixed: true },
  { code: '810000', full: '香港特别行政区', short: '香港', direct: true },
  { code: '820000', full: '澳门特别行政区', short: '澳门', direct: true }
];

/**
 * 省直辖县级行政区补充清单。
 * DataV 省级 _full 里这些单元的 adcode 末两位不为 00，按「地级」规则会被过滤掉，
 * 但它们有独立的百度迁徙数据且是常见目的地，这里显式补回来。
 */
const EXTRA_ADCODES = [
  { adcode: '419001', province: '河南' },   // 济源市
  { adcode: '429004', province: '湖北' },   // 仙桃市
  { adcode: '429005', province: '湖北' },   // 潜江市
  { adcode: '429006', province: '湖北' },   // 天门市
  { adcode: '429021', province: '湖北' },   // 神农架林区
  { adcode: '469001', province: '海南' },   // 五指山市
  { adcode: '469002', province: '海南' },   // 琼海市
  { adcode: '469005', province: '海南' },   // 文昌市
  { adcode: '469006', province: '海南' },   // 万宁市
  { adcode: '469007', province: '海南' }    // 东方市
];

/**
 * 台湾省目的地清单。
 * DataV 无 710000_full 数据（返回 NoSuchKey），百度迁徙也只有省级粒度，
 * 因此沿用原人工清单的坐标与文案，热度取百度迁徙台湾省级（710000）指数。
 */
const TAIWAN_CITIES = [
  { name: '台北', adcode: '710000' },
  { name: '高雄', adcode: '710000' },
  { name: '台中', adcode: '710000' },
  { name: '台南', adcode: '710000' },
  { name: '花莲', adcode: '710000' },
  { name: '垦丁', adcode: '710000' }
];

/**
 * DataV 行政区全称 -> 展示短名（仅列通用后缀规则处理不好的自治州 / 盟 / 地区）。
 * 自治州全称里嵌套民族称谓（如「黔西南布依族苗族自治州」），用正则容易误伤，
 * 这里统一显式声明，保证每一个名字都可控、可读。
 */
const PREFECTURE_RENAME = {
  延边朝鲜族自治州: '延边',
  恩施土家族苗族自治州: '恩施',
  湘西土家族苗族自治州: '湘西',
  黔东南苗族侗族自治州: '黔东南',
  黔南布依族苗族自治州: '黔南',
  黔西南布依族苗族自治州: '黔西南',
  楚雄彝族自治州: '楚雄',
  红河哈尼族彝族自治州: '红河',
  文山壮族苗族自治州: '文山',
  西双版纳傣族自治州: '西双版纳',
  大理白族自治州: '大理',
  德宏傣族景颇族自治州: '德宏',
  怒江傈僳族自治州: '怒江',
  迪庆藏族自治州: '迪庆',
  阿坝藏族羌族自治州: '阿坝',
  甘孜藏族自治州: '甘孜',
  凉山彝族自治州: '凉山',
  临夏回族自治州: '临夏',
  甘南藏族自治州: '甘南',
  海北藏族自治州: '海北',
  黄南藏族自治州: '黄南',
  海南藏族自治州: '海南州',
  果洛藏族自治州: '果洛',
  玉树藏族自治州: '玉树',
  海西蒙古族藏族自治州: '海西',
  昌吉回族自治州: '昌吉',
  博尔塔拉蒙古自治州: '博尔塔拉',
  巴音郭楞蒙古自治州: '巴音郭楞',
  克孜勒苏柯尔克孜自治州: '克孜勒苏',
  伊犁哈萨克自治州: '伊犁',
  兴安盟: '兴安',
  锡林郭勒盟: '锡林郭勒',
  阿拉善盟: '阿拉善',
  大兴安岭地区: '大兴安岭'
};

/**
 * 展示短名 -> 人工文案库中的另一个名字（盟/州驻地或同州著名目的地）。
 * 用于把「兴安盟」「黔东南」这类行政区名对回库里的具体目的地文案。
 */
const NAME_ALIAS = {
  兴安: '乌兰浩特',
  锡林郭勒: '锡林浩特',
  阿拉善: '额济纳',
  延边: '延吉',
  阿坝: '九寨沟',
  甘孜: '稻城亚丁',
  凉山: '西昌',
  海西: '德令哈',
  海南州: '青海湖',
  黔西南: '兴义',
  黔东南: '凯里',
  黔南: '荔波',
  德宏: '芒市',
  迪庆: '香格里拉',
  博尔塔拉: '博乐',
  巴音郭楞: '库尔勒',
  克孜勒苏: '阿图什',
  伊犁: '伊宁',
  大兴安岭: '漠河'
};

/** 拥挤等级（与 data/cities.js、app.js 保持一致）。 */
const CROWD_RULES = [
  { min: 85, label: '爆满' },
  { min: 70, label: '拥挤' },
  { min: 50, label: '适中' },
  { min: 30, label: '舒适' },
  { min: 0, label: '冷清' }
];

/* ------------------------------------------------------------------ *
 * 三峡专题点位（奉节 / 巫山 / 巴东 / 秭归）
 *
 * 这四个是长江三峡沿线的**县级**行政区，百度迁徙最小粒度是地级行政区，
 * 拿不到它们的迁徙数据（实测 historycurve 返回空 list），因此改从地方政府
 * 官方发布的 2025 国庆假日旅游统计采集。
 *
 * ⚠️ 关键：四县官方数据的**统计口径互不相同**（景区购票 / 全县接待 / A级景区），
 * 彼此不可比，更不能与百度迁徙指数比较，且没有任何单一口径是四县齐全的。
 * 因此它们只作「三峡专题」展示原始官方数据 + 标注口径，不参与全国热度排名，
 * 也绝不做任何折算或估算 —— 那会制造虚假的可比性。
 *
 * 数据来源均为政府官网 / 县文旅局，采集日期 2026-09-14。
 * ------------------------------------------------------------------ */
const SANXIA_OFFICIAL = [
  {
    name: '奉节',
    province: '重庆',
    lng: 109.465774,
    lat: 31.019967,
    tags: ['三峡', '诗词', '秋色'],
    reason: '白帝城·瞿塘峡是十元人民币背景，国庆因「课本游」爆火，三峡之巅需预约限流。',
    tip: '白帝城早上去人少，夔门观景台看日落；长假景区多日达预约上限，务必提前订票。',
    days: '2-3天',
    spots: ['白帝城·瞿塘峡', '三峡之巅', '夔门', '龙桥河'],
    official: {
      value: 22.73,
      unit: '万人次',
      caliber: '景区购票游客',
      yoy: '同比 +3.72%',
      detail: '白帝城·瞿塘峡 13.41 万、三峡之巅 8.89 万；旅游直接收入 1411.65 万元',
      source: '奉节县人民政府',
      url: 'https://cqfj.gov.cn/bm_168/whhlyfzwyh/zwxx_61736/dt_61738/202510/t20251010_15066577.html'
    }
  },
  {
    name: '巫山',
    province: '重庆',
    lng: 109.878928,
    lat: 31.074843,
    tags: ['三峡', '峡谷', '游船'],
    reason: '小三峡与巫峡·神女景区是三峡精华，长假连续多日达日承载峰值，停车场一位难求。',
    tip: '游船票提前订，神女景区走天路徒步；11 月红叶季比国庆更从容。',
    days: '2-3天',
    spots: ['小三峡·小小三峡', '巫峡·神女景区', '大昌古城', '三峡龙脊'],
    official: {
      value: 96.75,
      unit: '万人次',
      caliber: '全县接待游客（8 天）',
      yoy: '同比 +25.15%（按 7 天可比口径）',
      detail: '小三峡 5.75 万、神女景区 6.84 万（购票口径）；旅游综合收入 45083.27 万元',
      source: '巫山县文化和旅游委',
      url: 'https://www.cqlprm.cn/news-center/detail/3112988'
    }
  },
  {
    name: '巴东',
    province: '湖北',
    lng: 110.336665,
    lat: 31.041403,
    tags: ['三峡', '溪谷', '土家'],
    reason: '神农溪纤夫文化与巫峡口云海江湾，长假推出游轮首航、热气球等新玩法。',
    tip: '神农溪漂流半天足够；巫峡口看云海要早起，县城到景区有定制公交。',
    days: '2天',
    spots: ['神农溪', '巫峡口', '无源洞', '巴人河'],
    official: {
      value: 50.75,
      unit: '万人次',
      caliber: '全县接待游客',
      yoy: '未公布',
      detail: '旅游总收入 2.64 亿元；核心景区神农溪、巫峡口、无源洞、巴人河',
      source: '巴东县文化和旅游局',
      url: 'http://www.enshi.gov.cn/zq_50192/yzes/lyzx/202510/t20251010_1742812.html'
    }
  },
  {
    name: '秭归',
    province: '湖北',
    lng: 110.976785,
    lat: 30.823908,
    tags: ['屈原', '三峡', '脐橙'],
    reason: '屈原故里与三峡移民博物馆是核心，新开街的九歌巷子楚风夜市人气爆棚。',
    tip: '屈原故里可观三峡大坝全景；九歌巷子晚上去，节假日周边餐饮住宿涨价明显。',
    days: '2天',
    spots: ['屈原故里', '三峡移民博物馆', '九歌巷子', '三峡竹海'],
    official: {
      value: 13.56,
      unit: '万人次',
      caliber: 'A 级景区接待',
      yoy: '日均同比 +141.08%',
      detail: '三峡移民博物馆 8.5 万（单日峰值 1.8 万）、九歌巷子街区 38 万；A 级景区综合收入 457.39 万元',
      source: '秭归县人民政府 / 湖北日报',
      url: 'https://news.hubeidaily.net/mobile/c_4630281.html'
    }
  }
];

/** 无真实数据时按等级生成的默认文案模板。 */
const DEFAULT_COPY = {
  爆满: {
    tags: ['热门打卡', '城市漫步', '美食'],
    reason: '国庆迁入规模处于全国前列，核心商圈与热门景区人潮密集。',
    tip: '热门景点尽量预约最早场次，错开 10 月 1-3 日进城高峰。',
    days: '3天',
    spots: ['城区商圈', '城市地标', '本地老街']
  },
  拥挤: {
    tags: ['热门打卡', '美食', '亲子'],
    reason: '国庆迁入规模高于全国多数城市，热门景区与交通枢纽排队明显。',
    tip: '核心景区放在早上或傍晚，正午避开主街区。',
    days: '2-3天',
    spots: ['城市地标', '特色街区', '周边景区']
  },
  适中: {
    tags: ['城市漫步', '美食', '亲子'],
    reason: '国庆迁入规模处于全国中游，整体可逛，热门点位有人但不至于挤不动。',
    tip: '常规节奏安排即可，想拍照的热门点提前一小时到。',
    days: '2天',
    spots: ['城市地标', '特色街区', '城市公园']
  },
  舒适: {
    tags: ['小众秘境', '自然风光', '城市漫步'],
    reason: '国庆迁入规模偏低，人流可控，适合慢节奏行程。',
    tip: '行程可以排松一点，多留时间给本地街区和周边山水。',
    days: '2天',
    spots: ['周边山水', '老城街区', '本地市集']
  },
  冷清: {
    tags: ['小众秘境', '自然风光', '秋色'],
    reason: '国庆迁入规模处于全国低位，游客稀少，适合深度慢游。',
    tip: '公共交通班次少，建议自驾或提前查好返程班次。',
    days: '1-2天',
    spots: ['自然风光', '老城街区', '本地市集']
  }
};

/* ======================================================================
 * 1. 基础工具
 * ==================================================================== */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 发起 HTTPS GET 请求。
 * @param {string} url 完整 URL。
 * @param {Object} headers 额外请求头。
 * @returns {Promise<string>} 响应体文本。
 */
function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = httpsMod.get(url, {
      headers: Object.assign({ 'User-Agent': UA }, headers || {})
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        httpsGet(res.headers.location, headers).then(resolve, reject);
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    req.setTimeout(REQ_TIMEOUT, () => { req.destroy(new Error('timeout')); });
  });
}

/**
 * 带重试与控频的 GET。
 * @param {string} url 完整 URL。
 * @param {Object} headers 额外请求头。
 * @returns {Promise<string|null>} 成功返回文本，失败返回 null。
 */
async function fetchWithRetry(url, headers) {
  for (let attempt = 0; attempt <= MAX_RETRY; attempt += 1) {
    try {
      const text = await httpsGet(url, headers);
      await sleep(REQ_INTERVAL);
      return text;
    } catch (err) {
      if (attempt === MAX_RETRY) {
        await sleep(REQ_INTERVAL);
        return null;
      }
      await sleep(REQ_INTERVAL * (attempt + 2));
    }
  }
  return null;
}

/**
 * 读取缓存；不存在返回 null。
 * @param {string} name 缓存文件名。
 * @returns {string|null} 缓存内容。
 */
function readCache(name) {
  const file = path.join(CACHE_DIR, name);
  if (!fs.existsSync(file)) { return null; }
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    return null;
  }
}

/**
 * 写入缓存。
 * @param {string} name 缓存文件名。
 * @param {string} text 内容。
 * @returns {void}
 */
function writeCache(name, text) {
  if (!fs.existsSync(CACHE_DIR)) { fs.mkdirSync(CACHE_DIR, { recursive: true }); }
  fs.writeFileSync(path.join(CACHE_DIR, name), text, 'utf8');
}

/**
 * 解析 jsonp：取第一个 '(' 与最后一个 ')' 之间的内容。
 * @param {string} text 原始响应。
 * @returns {Object|null} 解析结果。
 */
function parseJsonp(text) {
  if (!text) { return null; }
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start < 0 || end <= start) { return null; }
  try {
    return JSON.parse(text.slice(start + 1, end));
  } catch (err) {
    return null;
  }
}

/**
 * 去掉行政区划后缀，得到用于匹配人工文案的短名。
 * @param {string} raw DataV 返回的行政区全名。
 * @returns {string} 短名。
 */
function shortName(raw) {
  const name = String(raw || '').trim();
  if (PREFECTURE_RENAME[name]) { return PREFECTURE_RENAME[name]; }
  let out = name.replace(/特别行政区$/, '');
  out = out.replace(/(?:地区|市|盟|林区|新区|县|旗)$/, '');
  return out || name;
}

/**
 * 按热度指数推导拥挤等级。
 * @param {number} heat 热度指数 0-100。
 * @returns {string} 等级文案。
 */
function crowdOf(heat) {
  for (let i = 0; i < CROWD_RULES.length; i += 1) {
    if (heat >= CROWD_RULES[i].min) { return CROWD_RULES[i].label; }
  }
  return CROWD_RULES[CROWD_RULES.length - 1].label;
}

/**
 * 数组分位数（线性插值）。
 * @param {number[]} sorted 升序数组。
 * @param {number} p 0-1。
 * @returns {number} 分位值。
 */
function quantile(sorted, p) {
  if (!sorted.length) { return 0; }
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) { return sorted[lo]; }
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * 数组中位数。
 * @param {number[]} arr 输入数组。
 * @returns {number} 中位数，空数组返回 0。
 */
function median(arr) {
  if (!arr.length) { return 0; }
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) { return sorted[mid]; }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 数值保留一位小数。
 * @param {number} value 输入值。
 * @returns {number} 一位小数。
 */
function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * 数值保留三位小数（原始迁入规模指数）。
 * @param {number} value 输入值。
 * @returns {number} 三位小数。
 */
function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/* ======================================================================
 * 2. 读取旧数据（人工文案）
 * ==================================================================== */

/**
 * 载入旧的 data/cities.js，取出人工撰写字段；首次运行备份到 tools/legacy-city-copy.json。
 * @returns {Array<Object>} 人工文案记录数组。
 */
function loadLegacyCopy() {
  if (fs.existsSync(LEGACY_COPY_FILE)) {
    return JSON.parse(fs.readFileSync(LEGACY_COPY_FILE, 'utf8'));
  }
  const g = global;
  g.window = g;
  const file = path.join(ROOT, 'data', 'cities.js');
  // 用独立沙箱执行，避免污染当前 global。
  const vm = require('vm');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox);
  const list = (sandbox.window && sandbox.window.CITIES) || [];
  const copy = list.map((c) => ({
    name: c.name,
    province: c.province,
    lng: c.lng,
    lat: c.lat,
    tags: c.tags,
    reason: c.reason,
    tip: c.tip,
    days: c.days,
    spots: c.spots
  }));
  fs.writeFileSync(LEGACY_COPY_FILE, JSON.stringify(copy, null, 2), 'utf8');
  console.log(`[copy] 已从旧 data/cities.js 备份 ${copy.length} 条人工文案 -> tools/legacy-city-copy.json`);
  return copy;
}

/* ======================================================================
 * 3. 拉取城市清单（DataV.GeoAtlas）
 * ==================================================================== */

/**
 * 拉取某省的 DataV 边界数据（带缓存）。
 * @param {string} code 省级 adcode。
 * @returns {Promise<Object|null>} FeatureCollection 或 null。
 */
async function fetchDataV(code) {
  const cacheName = `datav_${code}.json`;
  let text = readCache(cacheName);
  if (text === null) {
    text = await fetchWithRetry(`https://geo.datav.aliyun.com/areas_v3/bound/${code}_full.json`, {});
    if (text) { writeCache(cacheName, text); }
  }
  if (!text) { return null; }
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

/**
 * 构建全国城市清单。
 * @returns {Promise<Object>} { cities, skipped }。
 */
async function buildCityList() {
  const cities = [];
  const skipped = [];
  const seen = new Set();

  for (let i = 0; i < PROVINCES.length; i += 1) {
    const prov = PROVINCES[i];
    const geo = await fetchDataV(prov.code);

    // 直辖市 / 港澳：DataV _full 返回的是下辖区县，这里把省本身作为一个城市。
    if (prov.direct) {
      cities.push({
        adcode: prov.code,
        name: prov.short,
        province: prov.short,
        lng: null,
        lat: null,
        rawName: prov.full
      });
      seen.add(prov.code);
      process.stdout.write(`[list] ${prov.short}(直辖市/特别行政区) 作为 1 个城市\n`);
      continue;
    }

    // 台湾省：DataV 无数据，使用固定清单。
    if (prov.fixed || !geo || !Array.isArray(geo.features)) {
      TAIWAN_CITIES.forEach((item) => {
        cities.push({
          adcode: item.adcode,
          name: item.name,
          province: prov.short,
          lng: null,
          lat: null,
          rawName: item.name
        });
      });
      process.stdout.write(`[list] ${prov.short} DataV 无数据，使用内置清单 ${TAIWAN_CITIES.length} 个\n`);
      continue;
    }

    let count = 0;
    geo.features.forEach((f) => {
      const props = f.properties || {};
      const adcode = String(props.adcode || '');
      if (!adcode) { return; }
      const isPrefecture = adcode.slice(4) === '00';
      const isExtra = EXTRA_ADCODES.some((e) => e.adcode === adcode);
      if (!isPrefecture && !isExtra) { return; }
      if (seen.has(adcode)) { return; }
      const center = props.center || props.centroid;
      seen.add(adcode);
      cities.push({
        adcode: adcode,
        name: shortName(props.name),
        province: prov.short,
        lng: Array.isArray(center) ? Number(center[0]) : null,
        lat: Array.isArray(center) ? Number(center[1]) : null,
        rawName: props.name
      });
      count += 1;
    });

    // 补充省直辖县级行政区（DataV 里可能与上面重复，seen 会去重）。
    EXTRA_ADCODES.filter((e) => e.province === prov.short).forEach((e) => {
      if (seen.has(e.adcode)) { return; }
      const f = geo.features.find((x) => String((x.properties || {}).adcode) === e.adcode);
      if (!f) { return; }
      const center = (f.properties || {}).center || (f.properties || {}).centroid;
      seen.add(e.adcode);
      cities.push({
        adcode: e.adcode,
        name: shortName(f.properties.name),
        province: prov.short,
        lng: Array.isArray(center) ? Number(center[0]) : null,
        lat: Array.isArray(center) ? Number(center[1]) : null,
        rawName: f.properties.name
      });
      count += 1;
    });

    if (count === 0) { skipped.push(prov.short); }
    process.stdout.write(`[list] ${prov.short} ${count} 个地级行政区\n`);
  }

  return { cities, skipped };
}

/* ======================================================================
 * 4. 拉取真实热度（百度迁徙）
 * ==================================================================== */

/**
 * 拉取某城市的迁入规模指数序列（带缓存）。
 * @param {string} adcode 城市 adcode。
 * @param {boolean} force 是否忽略缓存。
 * @returns {Promise<Object|null>} { list: {date:value} } 或 null。
 */
async function fetchMigration(adcode, force) {
  const cacheName = `mig_${adcode}.json`;
  if (!force) {
    const cached = readCache(cacheName);
    if (cached !== null) {
      try {
        return JSON.parse(cached);
      } catch (err) {
        // 缓存损坏，重新抓取
      }
    }
  }
  const url = 'https://huiyan.baidu.com/migration/historycurve.jsonp?dt=city'
    + `&id=${adcode}&type=move_in`;
  const text = await fetchWithRetry(url, { Referer: 'https://qianxi.baidu.com/' });
  if (!text) { return null; }
  const json = parseJsonp(text);
  if (!json || json.errno !== 0 || !json.data || !json.data.list) { return null; }
  writeCache(cacheName, JSON.stringify({ list: json.data.list }));
  return { list: json.data.list };
}

/**
 * 计算某个日期窗口内的日均迁入规模指数。
 * @param {Object} list 日期 -> 指数。
 * @param {string[]} range 日期数组。
 * @returns {{avg: number, days: number}|null} 均值与有效天数，不足 4 天返回 null。
 */
function avgOfRange(list, range) {
  let sum = 0;
  let days = 0;
  range.forEach((d) => {
    const v = Number(list[d]);
    if (Number.isFinite(v)) {
      sum += v;
      days += 1;
    }
  });
  if (days < 4) { return null; }
  return { avg: sum / days, days: days };
}

/* ======================================================================
 * 5. 归一化
 * ==================================================================== */

/**
 * 方案 A：对数归一化（按 p2 / p98 截断，抑制极端值）。
 * @param {Array<Object>} rows 含 v 字段的城市数组。
 * @returns {Object} { heatById, min, max, p2, p98 }。
 */
function normalizeLog(rows) {
  const values = rows.map((r) => r.v).sort((a, b) => a - b);
  const lo = quantile(values, 0.02);
  const hi = quantile(values, 0.98);
  const lnLo = Math.log(Math.max(lo, 1e-6));
  const lnHi = Math.log(Math.max(hi, lo + 1e-6));
  const span = lnHi - lnLo;
  const heatById = {};
  rows.forEach((r) => {
    const ratio = (Math.log(Math.max(r.v, 1e-6)) - lnLo) / span;
    heatById[r.adcode] = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  });
  return { heatById: heatById, lo: lo, hi: hi, span: span };
}

/**
 * 方案 B：百分位映射（保证五档分布均匀）。
 * @param {Array<Object>} rows 含 v 字段的城市数组（按 v 升序）。
 * @returns {Object} { heatById }。
 */
function normalizePercentile(rows) {
  const sorted = rows.slice().sort((a, b) => a.v - b.v);
  const n = sorted.length;
  const heatById = {};
  sorted.forEach((r, i) => {
    heatById[r.adcode] = Math.round((i / (n - 1)) * 100);
  });
  return { heatById: heatById };
}

/**
 * 统计某套映射的五档分布。
 * @param {Array<Object>} rows 城市数组。
 * @param {Object} heatById adcode -> heat。
 * @returns {Object} 各档计数。
 */
function tierStats(rows, heatById) {
  const stat = { 爆满: 0, 拥挤: 0, 适中: 0, 舒适: 0, 冷清: 0 };
  rows.forEach((r) => {
    stat[crowdOf(heatById[r.adcode])] += 1;
  });
  return stat;
}

/**
 * 判断某套映射的分布是否可用。
 * @param {Object} stat 各档计数。
 * @param {number} total 总数。
 * @returns {boolean} 是否可用。
 */
function isGoodSpread(stat, total) {
  if (stat.爆满 < 5 || stat.爆满 > total * 0.25) { return false; }
  if (stat.冷清 < total * 0.05 || stat.冷清 > total * 0.5) { return false; }
  const maxTier = Math.max(stat.爆满, stat.拥挤, stat.适中, stat.舒适, stat.冷清);
  if (maxTier > total * 0.55) { return false; }
  return true;
}

/* ======================================================================
 * 6. 文案合并
 * ==================================================================== */

/**
 * 为没有人工文案的城市生成默认文案。
 * @param {Object} city 城市对象。
 * @param {number} heat 热度指数。
 * @returns {Object} { tags, reason, tip, days, spots }。
 */
function makeDefaultCopy(city, heat) {
  const level = crowdOf(heat);
  const tpl = DEFAULT_COPY[level];
  return {
    tags: tpl.tags.slice(),
    reason: `国庆迁入规模指数 ${city.v.toFixed(2)}，${tpl.reason}`,
    tip: tpl.tip,
    days: tpl.days,
    spots: [city.name + tpl.spots[0], city.name + tpl.spots[1], city.name + tpl.spots[2]]
  };
}

/**
 * 匹配人工文案：短名精确 -> 别名 -> 同省包含匹配。
 * @param {Object} city 城市对象。
 * @param {Map<string, Object>} byName 名称索引。
 * @param {Map<string, Object[]>} byProvince 省份索引。
 * @returns {Object|null} 命中的人工文案。
 */
function matchCopy(city, byName, byProvince) {
  if (byName.has(city.name)) { return byName.get(city.name); }
  const alias = NAME_ALIAS[city.name];
  if (alias && byName.has(alias)) { return byName.get(alias); }
  const sameProv = byProvince.get(city.province) || [];
  for (let i = 0; i < sameProv.length; i += 1) {
    const cand = sameProv[i];
    if (cand.name.length >= 2 && (city.name.indexOf(cand.name) === 0 || cand.name.indexOf(city.name) === 0)) {
      return cand;
    }
  }
  return null;
}

/* ======================================================================
 * 7. 输出 data/cities.js
 * ==================================================================== */

/**
 * 生成 data/cities.js 文件内容。
 * @param {Array<Object>} rows 最终城市数据。
 * @param {string} methodDesc 归一化方案说明。
 * @returns {string} 文件内容。
 */
function renderCitiesFile(rows, methodDesc) {
  const lines = [];
  lines.push('/* ------------------------------------------------------------------ *');
  lines.push(' * data/cities.js —— 全国城市「国庆热度」数据集（真实数据版）');
  lines.push(' *');
  lines.push(' * 结构说明');
  lines.push(' *   CITY_RAW 为紧凑元组数组，字段顺序见 CITY_SCHEMA：');
  lines.push(' *     [0] name      城市 / 行政区名称');
  lines.push(' *     [1] province  所属省级行政区简称');
  lines.push(' *     [2] lng       中心经度（阿里云 DataV.GeoAtlas 提供）');
  lines.push(' *     [3] lat       中心纬度（阿里云 DataV.GeoAtlas 提供）');
  lines.push(' *     [4] heat      国庆热度指数 0-100（整数，越高越挤），由真实迁入规模指数映射而来');
  lines.push(' *     [5] delta     同比变化 = 2025 年国庆日均指数 - 2024 年国庆日均指数（正=更挤）');
  lines.push(' *     [6] tags      标签数组（用于快捷筛选）');
  lines.push(' *     [7] reason    一句话说明国庆去这里的体验 / 拥挤情况');
  lines.push(' *     [8] tip       一句话实用建议（错峰时间、交通、住宿）');
  lines.push(' *     [9] days      建议游玩天数');
  lines.push(' *     [10] spots    2-4 个代表景点');
  lines.push(' *     [11] src      热度来源：real=本市真实数据 / province=省级汇总 / median=同级中位数兜底');
  lines.push(' *     [12] raw      2025 国庆 7 天日均迁入规模「原始指数」（3 位小数，未归一化）');
  lines.push(' *     [13] official 三峡专题官方数据对象（仅奉节/巫山/巴东/秭归四个县级点位有值，其余为 null）');
  lines.push(' *                   结构 {value,unit,caliber,yoy,detail,source,url}，口径与迁徙指数不可比');
  lines.push(' *');
  lines.push(' *   脚本末尾会把元组展开为标准对象数组，并按 heat 自动推导 crowd 字段：');
  lines.push(' *     >=85 爆满 / 70-84 拥挤 / 50-69 适中 / 30-49 舒适 / <30 冷清');
  lines.push(' *   最终对外暴露 window.CITIES（标准对象数组）。');
  lines.push(' *');
  lines.push(' * 热度指数口径（真实数据）');
  lines.push(' *   热度指数 = 2025 年国庆假期（10 月 1 日 - 10 月 7 日）日均人口迁入规模指数');
  lines.push(' *   经归一化映射到 0-100，数值越高代表假期迁入人流越集中、越拥挤。');
  lines.push(' *   原始指数来源：百度迁徙（百度地图慧眼）historycurve 接口（move_in）。');
  lines.push(' *   行政区划、经纬度与底图边界：阿里云 DataV.GeoAtlas（民政部行政区划标准）。');
  lines.push(' *');
  lines.push(` *   归一化方案：${methodDesc}`);
  lines.push(' *');
  lines.push(' *   本文件由 tools/fetch-real-data.js 自动生成，请勿手工编辑；');
  lines.push(' *   人工撰写的推荐理由 / 玩法 / 景点存放于 tools/legacy-city-copy.json。');
  lines.push(' * ------------------------------------------------------------------ */');
  lines.push('');
  lines.push('(function (global) {');
  lines.push("  'use strict';");
  lines.push('');
  lines.push('  /** 元组字段顺序（与 CITY_RAW 中每行一一对应）。 */');
  lines.push("  var CITY_SCHEMA = [");
  lines.push("    'name', 'province', 'lng', 'lat', 'heat', 'delta',");
  lines.push("    'tags', 'reason', 'tip', 'days', 'spots', 'src', 'raw', 'official'");
  lines.push('  ];');
  lines.push('');
  lines.push('  /** 拥挤等级定义：按 min 从高到低匹配。 */');
  lines.push('  var CROWD_RULES = [');
  CROWD_RULES.forEach((r, i) => {
    lines.push(`    { min: ${r.min}, label: '${r.label}' }${i === CROWD_RULES.length - 1 ? '' : ','}`);
  });
  lines.push('  ];');
  lines.push('');
  lines.push('  /**');
  lines.push('   * 根据热度指数推导拥挤等级。');
  lines.push('   * @param {number} heat 热度指数 0-100。');
  lines.push('   * @returns {string} 拥挤等级文案。');
  lines.push('   */');
  lines.push('  function crowdOf(heat) {');
  lines.push('    for (var i = 0; i < CROWD_RULES.length; i++) {');
  lines.push('      if (heat >= CROWD_RULES[i].min) {');
  lines.push('        return CROWD_RULES[i].label;');
  lines.push('      }');
  lines.push('    }');
  lines.push("    return CROWD_RULES[CROWD_RULES.length - 1].label;");
  lines.push('  }');
  lines.push('');
  lines.push('  /** 紧凑元组数组（按省级行政区划顺序排列）。 */');
  lines.push('  var CITY_RAW = [');

  let currentProvince = '';
  rows.forEach((row, idx) => {
    if (row.province !== currentProvince) {
      currentProvince = row.province;
      lines.push(`    // ===== ${currentProvince} =====`);
    }
    const tuple = [
      JSON.stringify(row.name),
      JSON.stringify(row.province),
      row.lng.toFixed(2),
      row.lat.toFixed(2),
      String(row.heat),
      String(row.delta),
      JSON.stringify(row.tags),
      JSON.stringify(row.reason),
      JSON.stringify(row.tip),
      JSON.stringify(row.days),
      JSON.stringify(row.spots),
      JSON.stringify(row.src),
      row.raw === null ? 'null' : String(row.raw),
      row.official ? JSON.stringify(row.official) : 'null'
    ];
    const comma = idx === rows.length - 1 ? '' : ',';
    lines.push('    [' + tuple.join(', ') + ']' + comma);
  });

  lines.push('  ];');
  lines.push('');
  lines.push('  /** 把紧凑元组展开成标准对象数组，并自动补齐 crowd 字段。 */');
  lines.push('  global.CITIES = CITY_RAW.map(function (row) {');
  lines.push('    var item = {};');
  lines.push('    for (var i = 0; i < CITY_SCHEMA.length; i++) {');
  lines.push('      item[CITY_SCHEMA[i]] = row[i];');
  lines.push('    }');
  lines.push('    item.crowd = crowdOf(item.heat);');
  lines.push('    return item;');
  lines.push('  });');
  lines.push('');
  lines.push('  /** 同时暴露原始元组与推导函数，便于自检脚本使用。 */');
  lines.push('  global.CITY_RAW = CITY_RAW;');
  lines.push('  global.CITY_CROWD_OF = crowdOf;');
  lines.push('})(typeof window !== \'undefined\' ? window : globalThis);');
  lines.push('');
  return lines.join('\n');
}

/* ======================================================================
 * 8. 主流程
 * ==================================================================== */

/**
 * 主流程。
 * @returns {Promise<void>}
 */
async function main() {
  const argv = process.argv.slice(2);
  const force = argv.indexOf('--force') !== -1;
  const dry = argv.indexOf('--dry') !== -1;

  console.log('==================================================');
  console.log(' 接入真实数据源：DataV.GeoAtlas + 百度迁徙');
  console.log('==================================================');

  // ---------- 步骤 1：城市清单 ----------
  console.log('\n[1/5] 拉取省级行政区划下的城市清单（DataV.GeoAtlas）...');
  const { cities, skipped } = await buildCityList();
  console.log(`[1/5] 城市清单完成：${cities.length} 个城市 / 行政区`);
  if (skipped.length) { console.log(`[1/5] 无 DataV 数据的省级单位：${skipped.join('、')}`); }

  // ---------- 步骤 2：人工文案 ----------
  console.log('\n[2/5] 读取人工文案库 ...');
  const legacy = loadLegacyCopy();
  const byName = new Map();
  const byProvince = new Map();
  legacy.forEach((item) => {
    if (!byName.has(item.name)) { byName.set(item.name, item); }
    if (!byProvince.has(item.province)) { byProvince.set(item.province, []); }
    byProvince.get(item.province).push(item);
  });
  console.log(`[2/5] 人工文案 ${legacy.length} 条`);

  // ---------- 步骤 3：真实热度 ----------
  console.log(`\n[3/5] 拉取百度迁徙迁入规模指数（${cities.length} 个城市，间隔 ${REQ_INTERVAL}ms）...`);
  const failed = [];
  const noData = [];
  let cacheHit = 0;

  for (let i = 0; i < cities.length; i += 1) {
    const city = cities[i];
    const cacheName = `mig_${city.adcode}.json`;
    const hadCache = !force && readCache(cacheName) !== null;
    const data = await fetchMigration(city.adcode, force);
    if (hadCache) { cacheHit += 1; }

    if (!data || !data.list) {
      failed.push({ name: city.name, province: city.province, adcode: city.adcode, reason: '请求失败' });
      city.v = null;
    } else {
      const a25 = avgOfRange(data.list, RANGE_2025);
      const a24 = avgOfRange(data.list, RANGE_2024);
      if (!a25) {
        noData.push({ name: city.name, province: city.province, adcode: city.adcode, reason: '无 2025 国庆数据' });
        city.v = null;
      } else {
        city.v = a25.avg;
        city.v2025 = a25.avg;
        city.v2024 = a24 ? a24.avg : null;
      }
    }

    if ((i + 1) % 50 === 0 || i === cities.length - 1) {
      console.log(`[3/5] 进度 ${i + 1}/${cities.length}（缓存命中 ${cacheHit}）`);
    }
  }

  const valid = cities.filter((c) => Number.isFinite(c.v));
  console.log(`[3/5] 真实数据：${valid.length} 个；无数据：${noData.length} 个；请求失败：${failed.length} 个`);

  if (dry) {
    console.log('\n[dry] 已跳过归一化与写文件。');
    return;
  }

  // ---------- 步骤 4：归一化 + 同比 ----------
  console.log('\n[4/5] 归一化与同比计算 ...');
  const logMap = normalizeLog(valid);
  const pctMap = normalizePercentile(valid);
  const statLog = tierStats(valid, logMap.heatById);
  const statPct = tierStats(valid, pctMap.heatById);
  console.log(`[4/5] 方案A 对数归一化（p2=${logMap.lo.toFixed(3)}, p98=${logMap.hi.toFixed(3)}）分布：`, JSON.stringify(statLog));
  console.log('[4/5] 方案B 百分位映射分布：', JSON.stringify(statPct));

  let useLog = isGoodSpread(statLog, valid.length);
  const chosenMap = useLog ? logMap.heatById : pctMap.heatById;
  let methodDesc = useLog
    ? `对数归一化（按 p2=${logMap.lo.toFixed(3)} / p98=${logMap.hi.toFixed(3)} 分位截断，`
      + '再对 ln(v) 做线性映射到 0-100；迁入规模呈长尾分布，取对数后可拉开中小城市区分度，'
      + '分位截断用于抑制极个别极端值对整体区间的挤压）'
    : '百分位映射（按迁入规模指数的全国百分位映射到 0-100，保证五档分布均匀）';
  console.log(`[4/5] 采用方案：${useLog ? 'A 对数归一化' : 'B 百分位映射'}`);

  // 无数据城市：省级中位数兜底；全省都无数据则用全国中位数。
  const nationalMedian = median(valid.map((c) => c.v));
  const provinceMedian = new Map();
  valid.forEach((c) => {
    if (!provinceMedian.has(c.province)) { provinceMedian.set(c.province, []); }
    provinceMedian.get(c.province).push(c.v);
  });
  const provinceMedianValue = new Map();
  provinceMedian.forEach((arr, p) => { provinceMedianValue.set(p, median(arr)); });

  const fallbackList = [];
  let missingBase2024 = 0;
  cities.forEach((city) => {
    if (!Number.isFinite(city.v)) {
      const fallback = provinceMedianValue.has(city.province)
        ? provinceMedianValue.get(city.province)
        : nationalMedian;
      city.v = fallback;
      city.src = 'median';
      city.v2025 = null;
      city.v2024 = null;
      fallbackList.push({ name: city.name, province: city.province, adcode: city.adcode, v: round1(fallback) });
    } else if (city.province === '台湾') {
      city.src = 'province';
    } else {
      city.src = 'real';
    }
    city.heat = chosenMap[city.adcode];
    if (city.heat === undefined) {
      // 兜底：无数据城市不在归一化集合里，用其 v 重新按映射公式算一次。
      const ratio = (Math.log(Math.max(city.v, 1e-6)) - Math.log(Math.max(logMap.lo, 1e-6))) / logMap.span;
      city.heat = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    }
    if (city.v2025 !== null && city.v2024 === null) { missingBase2024 += 1; }
    city.delta = (city.v2025 !== null && city.v2024 !== null)
      ? round1(city.v2025 - city.v2024)
      : 0;
  });

  // ---------- 步骤 5：合并文案并输出 ----------
  console.log('\n[5/5] 合并人工文案并写出 data/cities.js ...');
  const rows = [];
  const noCopy = [];
  cities.forEach((city) => {
    // 坐标：DataV 缺失时用人工文案库里的坐标兜底。
    if (!Number.isFinite(city.lng) || !Number.isFinite(city.lat)) {
      const hit = byName.get(city.name) || byName.get(NAME_ALIAS[city.name] || '');
      if (hit) {
        city.lng = hit.lng;
        city.lat = hit.lat;
      }
    }
    if (!Number.isFinite(city.lng) || !Number.isFinite(city.lat)
      || city.lng < 73 || city.lng > 136 || city.lat < 3 || city.lat > 54) {
      console.warn(`[warn] ${city.name}(${city.province}) 坐标缺失，已剔除：lng=${city.lng} lat=${city.lat}`);
      return;
    }

    const hit = matchCopy(city, byName, byProvince);
    let copy = null;
    if (hit) {
      copy = {
        tags: hit.tags && hit.tags.length ? hit.tags.slice() : null,
        reason: hit.reason,
        tip: hit.tip,
        days: hit.days,
        spots: hit.spots && hit.spots.length >= 2 ? hit.spots.slice() : null
      };
    }
    if (!copy || !copy.tags || !copy.reason || !copy.tip || !copy.days || !copy.spots) {
      const gen = makeDefaultCopy(city, city.heat);
      copy = {
        tags: (copy && copy.tags) || gen.tags,
        reason: (copy && copy.reason) || gen.reason,
        tip: (copy && copy.tip) || gen.tip,
        days: (copy && copy.days) || gen.days,
        spots: (copy && copy.spots) || gen.spots
      };
      noCopy.push(city.name);
    }

    // 省级汇总口径（台湾省各地）数据覆盖有限，文案里必须写清楚，避免误导。
    if (city.src === 'province') {
      copy.reason = `百度迁徙对${city.province}的数据覆盖有限，本指数为省级汇总口径的参考值，`
        + '与大陆城市不完全可比，出行请以当地官方发布为准。';
    }

    rows.push({
      name: city.name,
      province: city.province,
      lng: Number(city.lng),
      lat: Number(city.lat),
      heat: city.heat,
      delta: city.delta,
      tags: copy.tags,
      reason: copy.reason,
      tip: copy.tip,
      days: copy.days,
      spots: copy.spots,
      src: city.src,
      raw: round3(city.v),
      v: city.v
    });
  });

  // 追加三峡专题点位：这四个县级行政区拿不到百度迁徙数据（最小粒度是地级），
  // 改用地方政府官方发布的假日旅游统计。口径与迁徙指数不可比，只作专题展示：
  // heat 给中性占位值仅供散点渲染，不参与排名与统计，也不参与热度档位分布。
  SANXIA_OFFICIAL.forEach((c) => {
    rows.push({
      name: c.name,
      province: c.province,
      lng: c.lng,
      lat: c.lat,
      heat: 50,
      delta: 0,
      tags: c.tags,
      reason: c.reason,
      tip: c.tip,
      days: c.days,
      spots: c.spots,
      src: 'official',
      raw: null,
      // 刻意不写入来源 URL：data/cities.js 必须保持 file:// 下零外链，
      // 链接只保留在 SANXIA_OFFICIAL 常量与 README 中，用于人工溯源。
      official: {
        value: c.official.value,
        unit: c.official.unit,
        caliber: c.official.caliber,
        yoy: c.official.yoy,
        detail: c.official.detail,
        source: c.official.source
      },
      v: 0
    });
  });

  // 按省级顺序排序（与 PROVINCES 一致），省内按热度降序，热度相同按原始指数降序。
  const provOrder = new Map();
  PROVINCES.forEach((p, i) => { provOrder.set(p.short, i); });
  rows.sort((a, b) => {
    const pa = provOrder.has(a.province) ? provOrder.get(a.province) : 99;
    const pb = provOrder.has(b.province) ? provOrder.get(b.province) : 99;
    if (pa !== pb) { return pa - pb; }
    if (b.heat !== a.heat) { return b.heat - a.heat; }
    return b.v - a.v;
  });

  fs.writeFileSync(OUT_FILE, renderCitiesFile(rows, methodDesc), 'utf8');
  console.log(`[5/5] 已写出 ${OUT_FILE}（${rows.length} 个城市）`);

  // ---------- 报告 ----------
  const finalStat = { 爆满: 0, 拥挤: 0, 适中: 0, 舒适: 0, 冷清: 0 };
  // 三峡专题点位的 heat 是占位值，不计入热度档位分布。
  rows.forEach((r) => { if (r.src !== 'official') { finalStat[crowdOf(r.heat)] += 1; } });
  const provCount = new Set(rows.map((r) => r.province));

  const sortedByV = rows.filter((r) => r.src === 'real').sort((a, b) => b.v - a.v);
  console.log('\n================ 抓取报告 ================');
  console.log(`城市总数：${rows.length}｜省级覆盖：${provCount.size}/34`);
  const missingProv = PROVINCES.filter((p) => !provCount.has(p.short)).map((p) => p.short);
  if (missingProv.length) { console.log(`缺少省级单位：${missingProv.join('、')}`); }
  console.log(`归一化方案：${useLog ? '对数归一化(p2/p98 截断)' : '百分位映射'}`);
  console.log('五档分布：', JSON.stringify(finalStat));
  console.log(`\nTOP10 最挤（真实日均迁入规模指数）：`);
  sortedByV.slice(0, 10).forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${r.name}(${r.province}) heat=${r.heat} v2025=${r.v.toFixed(3)} delta=${r.delta}`);
  });
  console.log('\nTOP10 最冷清：');
  sortedByV.slice(-10).reverse().forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${r.name}(${r.province}) heat=${r.heat} v2025=${r.v.toFixed(3)} delta=${r.delta}`);
  });
  const valueRange = sortedByV.length
    ? `min=${sortedByV[sortedByV.length - 1].v.toFixed(3)} max=${sortedByV[0].v.toFixed(3)}`
    : 'n/a';
  console.log(`\n真实指数值域：${valueRange}`);
  console.log(`\n无真实数据（用中位数兜底）${fallbackList.length} 个：${fallbackList.map((f) => f.name + '(' + f.province + ')').join('、') || '无'}`);
  console.log(`未匹配到人工文案、已自动生成 ${noCopy.length} 个：${noCopy.join('、') || '无'}`);
  if (failed.length) {
    console.log(`\n请求失败 ${failed.length} 个：${failed.map((f) => f.name + '(' + f.province + ':' + f.adcode + ')').join('、')}`);
  }
  if (noData.length) {
    console.log(`接口无 2025 数据 ${noData.length} 个：${noData.map((f) => f.name + '(' + f.province + ':' + f.adcode + ')').join('、')}`);
  }
  console.log(`缺 2024 同比基数（delta 记为 0）的城市：${missingBase2024} 个`);
  const srcStat = {};
  rows.forEach((r) => { srcStat[r.src] = (srcStat[r.src] || 0) + 1; });
  console.log(`\n热度来源统计：${JSON.stringify(srcStat)}`);
  console.log('==========================================');
}

main().catch((err) => {
  console.error('[fatal]', err && err.stack ? err.stack : err);
  process.exit(1);
});
