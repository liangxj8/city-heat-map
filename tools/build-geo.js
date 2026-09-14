#!/usr/bin/env node
/**
 * tools/build-geo.js
 * ---------------------------------------------------------------------------
 * 把 data/china_full.json（标准 GeoJSON FeatureCollection）转换成
 * data/geo.js（内容为 `window.CHINA_GEO = {...};`）。
 *
 * 为什么要转换？
 *   本项目是「零构建、纯静态」站点，要求双击 index.html 用 file:// 协议直接打开。
 *   浏览器在 file:// 协议下会拦截 fetch() / XMLHttpRequest 读取本地 JSON（CORS），
 *   因此必须把边界数据包装成可 <script src> 引入的 JS 文件。
 *
 * 用法（在项目根目录执行）：
 *   node tools/build-geo.js
 *   node tools/build-geo.js --src other.json --out data/geo.js
 *
 * 数据来源：阿里云 DataV.GeoAtlas（民政部行政区划标准）
 *   https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json
 *   含台湾省、香港特别行政区、澳门特别行政区、南海诸岛，均为中国领土一部分。
 * ---------------------------------------------------------------------------
 */

'use strict';

var fs = require('fs');
var path = require('path');

/** 南海诸岛在原始数据中 name 为空字符串，这里补齐为规范名称。 */
var NANHAI_NAME = '南海诸岛';

/** 默认输入 / 输出路径（相对项目根目录）。 */
var DEFAULT_SRC = path.join('data', 'china_full.json');
var DEFAULT_OUT = path.join('data', 'geo.js');

/**
 * 解析命令行参数（仅支持 --src / --out 两个可选参数）。
 * @param {string[]} argv 命令行参数数组（不含 node 与脚本路径）。
 * @returns {{src: string, out: string}} 解析后的路径配置。
 */
function parseArgs(argv) {
  var config = { src: DEFAULT_SRC, out: DEFAULT_OUT };
  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === '--src' && argv[i + 1]) {
      config.src = argv[i + 1];
      i++;
    } else if (arg === '--out' && argv[i + 1]) {
      config.out = argv[i + 1];
      i++;
    } else if (arg === '-h' || arg === '--help') {
      console.log('用法: node tools/build-geo.js [--src <geojson路径>] [--out <输出js路径>]');
      process.exit(0);
    }
  }
  return config;
}

/**
 * 归一化 GeoJSON：补齐缺失的 name / center 字段，保证 ECharts registerMap 可用。
 * @param {Object} geo 原始 FeatureCollection。
 * @returns {Object} 归一化后的 FeatureCollection。
 */
function normalize(geo) {
  if (!geo || geo.type !== 'FeatureCollection' || !Array.isArray(geo.features)) {
    throw new Error('输入文件不是合法的 GeoJSON FeatureCollection');
  }
  geo.features.forEach(function (feature) {
    if (!feature.properties) {
      feature.properties = {};
    }
    // 南海诸岛要素的 name 为空字符串，补齐为规范名称
    if (!feature.properties.name) {
      feature.properties.name = NANHAI_NAME;
    }
    // ECharts 的 map / geo 组件使用 properties.center 作为默认标签锚点
    if (!feature.properties.center) {
      if (feature.properties.centroid) {
        feature.properties.center = feature.properties.centroid;
      } else {
        feature.properties.center = [0, 0];
      }
    }
  });
  return geo;
}

/**
 * 生成 data/geo.js 文件头注释。
 * @returns {string} 注释文本。
 */
function buildBanner() {
  var lines = [
    '/* ------------------------------------------------------------------ *',
    ' * data/geo.js —— 中国省级行政区边界（自动生成，请勿手工编辑）',
    ' *',
    ' * 生成脚本 : tools/build-geo.js',
    ' * 数据来源 : 阿里云 DataV.GeoAtlas（民政部行政区划标准）',
    ' *            https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json',
    ' * 说明     : 台湾省、香港特别行政区、澳门特别行政区、南海诸岛',
    ' *            作为中国领土的一部分完整呈现。',
    ' *',
    ' * 为什么是 .js 而不是 .json：站点需支持 file:// 直接打开，',
    ' * 浏览器会拦截 file:// 下的 fetch/XHR，故用 script 标签注入全局变量。',
    ' * ------------------------------------------------------------------ */'
  ];
  return lines.join('\n');
}

/**
 * 主流程。
 * @returns {void}
 */
function main() {
  var config = parseArgs(process.argv.slice(2));
  var rootDir = path.resolve(__dirname, '..');
  var srcPath = path.isAbsolute(config.src) ? config.src : path.join(rootDir, config.src);
  var outPath = path.isAbsolute(config.out) ? config.out : path.join(rootDir, config.out);

  var raw = fs.readFileSync(srcPath, 'utf8');
  var geo = normalize(JSON.parse(raw));

  var body = JSON.stringify(geo);
  var content = buildBanner() + '\nwindow.CHINA_GEO = ' + body + ';\n';

  fs.writeFileSync(outPath, content, 'utf8');

  var names = geo.features.map(function (f) { return f.properties.name; });
  console.log('[build-geo] 已生成: ' + path.relative(rootDir, outPath));
  console.log('[build-geo] 要素数量: ' + geo.features.length);
  console.log('[build-geo] 文件大小: ' + (Buffer.byteLength(content, 'utf8') / 1024).toFixed(1) + ' KB');
  console.log('[build-geo] 省级名称: ' + names.join('、'));
}

main();
