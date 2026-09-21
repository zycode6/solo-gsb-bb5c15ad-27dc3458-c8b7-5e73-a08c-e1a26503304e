'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeSeamAvoidance,
  compareResults,
  compareSegmentSets,
  canonicalSegs,
  viewToPieces,
  subtractPieces,
  piecesToView,
} = require('../src/seamMath');

const segPairs = (list) => list.map((s) => [s.startMm, s.endMm]);

test('viewToPieces: 跨零段拆分、整圈与零长度处理', () => {
  assert.deepEqual(viewToPieces({ startMm: 350, endMm: 30, wraps: true }, 400), [
    [350, 400],
    [0, 30],
  ]);
  assert.deepEqual(viewToPieces({ startMm: 0, endMm: 0, wraps: false, widthMm: 400 }, 400), [
    [0, 400],
  ]);
  assert.deepEqual(viewToPieces({ startMm: 0, endMm: 400 }, 400), [[0, 400]]);
  assert.deepEqual(viewToPieces({ startMm: 100, endMm: 100 }, 400), []);
});

test('subtractPieces: 线性区间差集', () => {
  assert.deepEqual(subtractPieces([[0, 100]], [[20, 40], [60, 80]]), [
    [0, 20],
    [40, 60],
    [80, 100],
  ]);
  assert.deepEqual(subtractPieces([[10, 50]], [[0, 100]]), []);
  assert.deepEqual(subtractPieces([], [[0, 100]]), []);
});

test('piecesToView: 贴零与贴周长的片段拼回跨零段', () => {
  const view = piecesToView(
    [
      [0, 20],
      [50, 100],
      [350, 400],
    ],
    400
  );
  assert.equal(view.length, 2);
  assert.deepEqual(segPairs([view[0]]), [[50, 100]]);
  assert.equal(view[1].startMm, 350);
  assert.equal(view[1].endMm, 20);
  assert.equal(view[1].wraps, true);
  assert.equal(view[1].widthMm, 70);
  // 整圈
  assert.deepEqual(piecesToView([[0, 400]], 400), [
    { startMm: 0, endMm: 400, wraps: false, widthMm: 400 },
  ]);
});

test('canonicalSegs: 跨零可行段合并为单段', () => {
  const r = computeSeamAvoidance(400, 20, [{ start: 60, end: 120 }]);
  const canon = canonicalSegs(r.feasible, 400);
  assert.equal(canon.length, 1);
  assert.equal(canon[0].startMm, 120);
  assert.equal(canon[0].endMm, 40);
  assert.equal(canon[0].wraps, true);
});

test('compareResults: 相同方案无任何差异', () => {
  const a = computeSeamAvoidance(400, 20, [{ start: 60, end: 120 }]);
  const b = computeSeamAvoidance(400, 20, [{ start: 60, end: 120 }]);
  const d = compareResults(a, b);
  for (const key of ['zones', 'forbidden', 'feasible']) {
    assert.equal(d[key].added.length, 0, key);
    assert.equal(d[key].removed.length, 0, key);
    assert.equal(d[key].moved.length, 0, key);
    assert.equal(d[key].unchanged.length, 1, key);
  }
});

test('compareResults: 保护区终点扩展 → 边界移动并产生新增区域', () => {
  const a = computeSeamAvoidance(400, 20, [{ start: 60, end: 120 }]);
  const b = computeSeamAvoidance(400, 20, [{ start: 60, end: 150 }]);
  const d = compareResults(a, b);

  // 保护区：终点 120 → 150
  assert.equal(d.zones.moved.length, 1);
  assert.equal(d.zones.moved[0].startDeltaMm, 0);
  assert.equal(d.zones.moved[0].endDeltaMm, 30);
  assert.deepEqual(segPairs(d.zones.added), [[120, 150]]);
  assert.equal(d.zones.removed.length, 0);

  // 禁用段同步扩展 [40,120] → [40,150]
  assert.equal(d.forbidden.moved.length, 1);
  assert.equal(d.forbidden.moved[0].endDeltaMm, 30);
  assert.deepEqual(segPairs(d.forbidden.added), [[120, 150]]);

  // 可行段起点被吃掉 30mm：120 → 150
  assert.equal(d.feasible.moved.length, 1);
  assert.equal(d.feasible.moved[0].startDeltaMm, 30);
  assert.equal(d.feasible.moved[0].endDeltaMm, 0);
  assert.deepEqual(segPairs(d.feasible.removed), [[120, 150]]);
  assert.equal(d.feasible.added.length, 0);
});

test('compareResults: 新增保护区 → 禁用段新增、可行段分裂（不误报移动）', () => {
  const a = computeSeamAvoidance(400, 20, [{ start: 60, end: 120 }]);
  const b = computeSeamAvoidance(400, 20, [
    { start: 60, end: 120 },
    { start: 240, end: 300 },
  ]);
  const d = compareResults(a, b);

  assert.deepEqual(segPairs(d.zones.added), [[240, 300]]);
  assert.deepEqual(segPairs(d.forbidden.added), [[220, 300]]);
  // 可行段被新禁用段挖去 [220,300]，属于分裂而非边界移动
  assert.deepEqual(segPairs(d.feasible.removed), [[220, 300]]);
  assert.equal(d.feasible.added.length, 0);
  assert.equal(d.feasible.moved.length, 0);
});

test('compareResults: 跨零保护区整体平移 → 单条边界移动', () => {
  const a = computeSeamAvoidance(400, 20, [{ start: 350, end: 30 }]);
  const b = computeSeamAvoidance(400, 20, [{ start: 355, end: 35 }]);
  const d = compareResults(a, b);

  assert.equal(d.zones.moved.length, 1);
  assert.equal(d.zones.moved[0].from.wraps, true);
  assert.equal(d.zones.moved[0].startDeltaMm, 5);
  assert.equal(d.zones.moved[0].endDeltaMm, 5);
  assert.deepEqual(segPairs(d.zones.added), [[30, 35]]);
  assert.deepEqual(segPairs(d.zones.removed), [[350, 355]]);
});

test('compareResults: 整圈可行 → 出现禁用段', () => {
  const a = computeSeamAvoidance(400, 20, []);
  const b = computeSeamAvoidance(400, 20, [{ start: 60, end: 120 }]);
  const d = compareResults(a, b);

  assert.deepEqual(segPairs(d.forbidden.added), [[40, 120]]);
  assert.deepEqual(segPairs(d.feasible.removed), [[40, 120]]);
  // 整圈段不参与边界移动
  assert.equal(d.feasible.moved.length, 0);
  assert.equal(d.feasible.unchanged.length, 0);
});

test('compareResults: 接缝宽度变化 → 禁用段起点前移', () => {
  const a = computeSeamAvoidance(400, 20, [{ start: 60, end: 120 }]);
  const b = computeSeamAvoidance(400, 30, [{ start: 60, end: 120 }]);
  const d = compareResults(a, b);

  assert.equal(d.seamWidthA, 20);
  assert.equal(d.seamWidthB, 30);
  assert.equal(d.forbidden.moved.length, 1);
  assert.equal(d.forbidden.moved[0].startDeltaMm, -10);
  assert.equal(d.forbidden.moved[0].endDeltaMm, 0);
  assert.deepEqual(segPairs(d.forbidden.added), [[30, 40]]);
  // 保护区本身未变
  assert.equal(d.zones.moved.length, 0);
  assert.equal(d.zones.unchanged.length, 1);
});

test('compareResults: 无解与有解之间的比较', () => {
  const a = computeSeamAvoidance(400, 50, [
    { start: 0, end: 180 },
    { start: 150, end: 400 },
  ]);
  assert.equal(a.noSolution, true);
  const b = computeSeamAvoidance(400, 20, [{ start: 60, end: 120 }]);
  const d = compareResults(a, b);

  // a 无可行段，b 的可行段全部为新增
  assert.equal(d.feasible.added.length, 1);
  assert.equal(d.feasible.added[0].widthMm, 320);
  // a 禁用覆盖整圈，b 的禁用段之外均为移除
  assert.equal(d.forbidden.removed.length, 1);
  assert.equal(d.forbidden.removed[0].startMm, 120);
  assert.equal(d.forbidden.removed[0].endMm, 40);
  assert.equal(d.forbidden.removed[0].wraps, true);
});

test('compareSegmentSets: 移动阈值内视为不变', () => {
  const mk = (s, e) => [{ startMm: s, endMm: e, wraps: false, widthMm: e - s }];
  const d = compareSegmentSets(mk(40, 120), mk(40.001, 120.001), 400);
  assert.equal(d.moved.length, 0);
  assert.equal(d.unchanged.length, 1);
});
