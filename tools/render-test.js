#!/usr/bin/env node
/**
 * tools/render-test.js
 * ---------------------------------------------------------------------------
 * 用 ECharts 5 的 SSR（服务端渲染）模式在无 DOM 的 Node 环境里真实渲染一次地图，
 * 验证 assets/app.js 中使用的图表配置在真实 ECharts 下可用：
 *   - echarts.registerMap('china', window.CHINA_GEO) 能被接受
 *   - geo 组件 + roam 配置合法
 *   - scatter（coordinateSystem: 'geo'）能把城市经纬度投影到画布内
 *   - visualMap（continuous, dimension=2, seriesIndex=0）配置合法
 *   - province 视图的 geo.regions 着色配置合法
 *   - effectScatter 高亮系列合法
 * 渲染产物 SVG 写到 tools/render-preview.svg，可直接用浏览器打开预览。
 *
 * 用法： node tools/render-test.js
 * ---------------------------------------------------------------------------
 */

'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.resolve(__dirname, '..');

var errors = [];

/**
 * 记录错误。
 * @param {string} msg 错误信息。
 * @returns {void}
 */
function fail(msg) { errors.push(msg); }

/**
 * 断言。
 * @param {boolean} cond 条件。
 * @param {string} label 描述。
 * @param {string} extra 附加信息。
 * @returns {void}
 */
function assert(cond, label, extra) {
  console.log((cond ? '  [OK]   ' : '  [FAIL] ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) { fail(label); }
}

/**
 * 在沙箱里执行声明 window.* 的 JS 文件。
 * @param {string} rel 相对路径。
 * @returns {Object} 沙箱对象。
 */
function loadWindowScript(rel) {
  var full = path.join(ROOT, rel);
  var sandbox = {};
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.console = console;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(full, 'utf8'), sandbox, { filename: full });
  return sandbox;
}

var WIDTH = 960;
var HEIGHT = 720;

/**
 * 主流程。
 * @returns {void}
 */
function main() {
  var geoBox = loadWindowScript(path.join('data', 'geo.js'));
  var cityBox = loadWindowScript(path.join('data', 'cities.js'));
  var geo = geoBox.CHINA_GEO;
  var cities = cityBox.CITIES;

  var echarts = require(path.join(ROOT, 'assets', 'echarts.min.js'));
  console.log('=== ECharts SSR 渲染验证 ===');
  console.log('  ECharts 版本: ' + echarts.version);

  // 1. 注册地图
  var registerOk = true;
  try {
    echarts.registerMap('china', geo);
  } catch (err) {
    registerOk = false;
    console.log('    ' + err.message);
  }
  assert(registerOk, "registerMap('china', CHINA_GEO)");

  // 2. 初始化 SSR 实例
  var chart = echarts.init(null, null, {
    renderer: 'svg',
    ssr: true,
    width: WIDTH,
    height: HEIGHT
  });

  var data = cities.map(function (c) {
    return { name: c.name, value: [c.lng, c.lat, c.heat], city: c };
  });

  /**
   * 构造与 assets/app.js buildChartOption() 等价的 option。
   * @param {string} view 'scatter' | 'province'。
   * @returns {Object} option。
   */
  function buildOption(view) {
    var regions = [];
    if (view === 'province') {
      var stats = {};
      cities.forEach(function (c) {
        if (!stats[c.province] || c.heat > stats[c.province]) {
          stats[c.province] = c.heat;
        }
      });
      regions = Object.keys(stats).map(function (p) {
        return { name: p, itemStyle: { areaColor: '#4fc3a1' } };
      });
    }
    return {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'item' },
      visualMap: {
        type: 'continuous',
        seriesIndex: 0,
        dimension: 2,
        min: 0,
        max: 100,
        left: 14,
        bottom: 18,
        orient: 'vertical',
        inRange: { color: ['#3aa0ff', '#4fc3a1', '#ffd166', '#f4925d', '#e4573d', '#9e1b32'] }
      },
      geo: {
        map: 'china',
        roam: true,
        zoom: 1.25,
        scaleLimit: { min: 1, max: 12 },
        itemStyle: { areaColor: '#eef1f7', borderColor: '#ffffff', borderWidth: 0.8 },
        emphasis: { itemStyle: { areaColor: '#dbe3f0' } },
        regions: regions
      },
      series: [
        {
          id: 'cityScatter',
          type: 'scatter',
          coordinateSystem: 'geo',
          data: data,
          symbolSize: function (value) { return 7 + (value[2] / 100) * 22; }
        },
        {
          id: 'cityHighlight',
          type: 'effectScatter',
          coordinateSystem: 'geo',
          data: [data[0]],
          symbolSize: 18,
          rippleEffect: { brushType: 'stroke', scale: 3 }
        }
      ]
    };
  }

  // 3. 渲染 scatter 视图
  var svgScatter = '';
  try {
    chart.setOption(buildOption('scatter'));
    svgScatter = chart.renderToSVGString();
  } catch (err) {
    console.log('    ' + err.stack);
  }
  assert(svgScatter.length > 20000, 'scatter 视图渲染出 SVG',
    (svgScatter.length / 1024).toFixed(1) + ' KB');

  // 4. 渲染 province 视图（带 regions）
  var svgProvince = '';
  try {
    chart.setOption(buildOption('province'), { replaceMerge: ['geo', 'series'] });
    svgProvince = chart.renderToSVGString();
  } catch (err) {
    console.log('    ' + err.stack);
  }
  assert(svgProvince.length > 20000, 'province 视图（regions 着色）渲染出 SVG',
    (svgProvince.length / 1024).toFixed(1) + ' KB');

  // 5. 校验城市经纬度能被正确投影到画布内
  chart.setOption(buildOption('scatter'));
  var inside = 0;
  var outside = [];
  cities.forEach(function (c) {
    var px = chart.convertToPixel({ geoIndex: 0 }, [c.lng, c.lat]);
    if (px && isFinite(px[0]) && isFinite(px[1]) &&
        px[0] >= -50 && px[0] <= WIDTH + 50 && px[1] >= -50 && px[1] <= HEIGHT + 50) {
      inside++;
    } else {
      outside.push(c.name + '(' + c.lng + ',' + c.lat + ')->' + JSON.stringify(px));
    }
  });
  assert(outside.length === 0, '全部 ' + cities.length + ' 个城市坐标投影到画布内',
    '落在画布内: ' + inside + ' / ' + cities.length +
    (outside.length ? '；异常: ' + outside.slice(0, 5).join('; ') : ''));

  // 6. 输出预览文件
  fs.writeFileSync(path.join(__dirname, 'render-preview.svg'), svgProvince, 'utf8');
  console.log('  预览文件已写出: tools/render-preview.svg');

  chart.dispose();

  console.log('');
  console.log('=== 渲染验证结果 ===');
  if (errors.length) {
    console.log('RESULT: FAIL (' + errors.length + ' 项)');
    process.exit(1);
  }
  console.log('RESULT: PASS');
}

main();
