'use strict';

/**
 * 圆筒包装接缝避让核心算法。
 *
 * 模型：筒体周长 C (mm) 对应 360°。接缝（含安全余量）占宽度 W (mm)。
 * 印刷保护区以 [start, end] (mm) 给出，沿周向正向延伸，允许跨零点。
 * 旋转量为 θ (mm, 0 <= θ < C)，表示接缝起点落在周向 θ 处，
 * 接缝占据 [θ, θ+W] (mod C)。接缝与任一保护区相交的 θ 即禁用。
 * 因此对保护区段 [a, b]，禁用区间为 [a-W, b] (mod C)。
 */

const EPS = 1e-9;

function mod(n, m) {
  return ((n % m) + m) % m;
}

function mmToDeg(mm, C) {
  return (mm / C) * 360;
}

/**
 * 将保护区 [startMm, endMm] 归一化到 [0, C] 上的若干不跨零区间。
 * 语义：从 start 沿正向走到 end（模 C）。start === end 视为零长度（忽略）；
 * 正向长度恰好为 C 的整数倍且端点不同视为整圈。
 * @returns {Array<[number, number]>} 满足 0 <= a <= b <= C 的区间列表
 */
function normalizeZone(startMm, endMm, C) {
  const len = mod(endMm - startMm, C);
  if (len === 0) {
    // 端点不同但正向距离为整圈 → 覆盖整圈；否则零长度，忽略
    return endMm !== startMm ? [[0, C]] : [];
  }
  const a = mod(startMm, C);
  const b = mod(endMm, C);
  if (a <= b) return [[a, b]];
  const pieces = [];
  if (C - a > EPS) pieces.push([a, C]);
  if (b > EPS) pieces.push([0, b]);
  return pieces;
}

/**
 * 由保护区段 [a, b]（已归一化到 [0, C]）生成接缝起点的禁用区间，
 * 即 [a-W, b] (mod C)，结果拆分为 [0, C] 内的不跨零片段。
 */
function forbiddenPieces(a, b, W, C) {
  const s = a - W;
  const e = b;
  if (e - s >= C - EPS) return [[0, C]];
  if (s < 0) {
    const pieces = [[s + C, C]];
    if (e > EPS) pieces.push([0, e]);
    return pieces;
  }
  return [[s, e]];
}

/** 合并 [0, C] 内的线性区间（不跨零合并，跨零由环形空隙处理）。 */
function mergeIntervals(intervals) {
  const sorted = intervals
    .filter(([a, b]) => b - a > EPS)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + EPS) {
      last[1] = Math.max(last[1], b);
    } else {
      merged.push([a, b]);
    }
  }
  return merged;
}

/**
 * 求合并后禁用区间在圆周上的空隙，即可行段。
 * 返回线性化区间，跨零空隙的 end 可能大于 C（如 [370, 410) 表示 370..C 与 0..10）。
 */
function computeGaps(merged, C) {
  if (merged.length === 0) return [[0, C]];
  const gaps = [];
  for (let i = 0; i < merged.length - 1; i++) {
    const s = merged[i][1];
    const e = merged[i + 1][0];
    if (e - s > EPS) gaps.push([s, e]);
  }
  const s = merged[merged.length - 1][1];
  const e = merged[0][0] + C;
  if (e - s > EPS) gaps.push([s, e]);
  return gaps;
}

/**
 * 主入口。
 * @param {number} C 周长 (mm)，> 0
 * @param {number} W 接缝安全宽度 (mm)，>= 0
 * @param {Array<{start: number, end: number}>} zones 印刷保护区 (mm)
 */
function computeSeamAvoidance(C, W, zones) {
  const zonePieces = [];
  const rawForbidden = [];
  for (const z of zones) {
    const pieces = normalizeZone(z.start, z.end, C);
    zonePieces.push(pieces);
    for (const [a, b] of pieces) {
      for (const p of forbiddenPieces(a, b, W, C)) rawForbidden.push(p);
    }
  }

  const merged = mergeIntervals(rawForbidden);
  const gaps = computeGaps(merged, C);
  const noSolution = gaps.length === 0;

  const feasible = gaps.map(([s, e]) => {
    const startMm = mod(s, C);
    const endMm = mod(e, C);
    return {
      startMm,
      endMm,
      startDeg: mmToDeg(startMm, C),
      endDeg: mmToDeg(endMm, C),
      widthMm: e - s,
      widthDeg: mmToDeg(e - s, C),
      wraps: e > C + EPS,
    };
  });

  // 默认选择：段宽最大者的中点；并列取模 C 后角度最小者
  let best = null;
  if (!noSolution) {
    if (merged.length === 0) {
      // 无禁用区间：整圈等距，按“角度最小”取 0
      best = { mm: 0, deg: 0 };
    } else {
      let bestGap = null;
      for (const [s, e] of gaps) {
        const width = e - s;
        const mid = mod((s + e) / 2, C);
        if (
          !bestGap ||
          width > bestGap.width + EPS ||
          (Math.abs(width - bestGap.width) <= EPS && mid < bestGap.mid - EPS)
        ) {
          bestGap = { width, mid };
        }
      }
      best = { mm: bestGap.mid, deg: mmToDeg(bestGap.mid, C) };
    }
  }

  const coveredMm = merged.reduce((acc, [a, b]) => acc + (b - a), 0);

  const toView = ([a, b]) => ({
    startMm: a,
    endMm: b,
    startDeg: mmToDeg(a, C),
    endDeg: mmToDeg(b, C),
  });

  return {
    circumference: C,
    seamWidth: W,
    seamWidthDeg: mmToDeg(W, C),
    zonePieces: zonePieces.map((pieces) => pieces.map(toView)),
    // 每个保护区扩展后的禁用片段（按起点排序、未合并），无解时用于展示覆盖整圈的区间链
    forbiddenChain: rawForbidden
      .slice()
      .sort((x, y) => x[0] - y[0] || x[1] - y[1])
      .map(toView),
    forbiddenMerged: merged.map(toView),
    feasible,
    best,
    noSolution,
    coveragePct: Math.min(100, (coveredMm / C) * 100),
  };
}

/* ---------------- 快照比较（圆周区间差集） ---------------- */

/** 边界移动判定阈值 (mm)：小于该值的边界偏移视为未移动（低于显示精度）。 */
const MOVE_EPS = 5e-3;

/**
 * 视图段 {startMm, endMm, wraps?, widthMm?} → [0, C] 内的线性片段。
 * 跨零段以 wraps=true 表示（拆为 [s, C] 与 [0, e]）；整圈段（widthMm 或
 * endMm-startMm 达到 C）归一为 [0, C]；零长度段忽略。
 */
function viewToPieces(seg, C) {
  if (seg.widthMm !== undefined && seg.widthMm >= C - EPS) return [[0, C]];
  if (!seg.wraps) {
    const a = seg.startMm;
    const b = seg.endMm;
    if (b - a >= C - EPS) return [[0, C]];
    return b - a > EPS ? [[a, b]] : [];
  }
  const pieces = [];
  if (C - seg.startMm > EPS) pieces.push([seg.startMm, C]);
  if (seg.endMm > EPS) pieces.push([0, seg.endMm]);
  return pieces;
}

/** 线性区间差集：base \ minus（均为 [0, C] 内片段），返回合并后的片段。 */
function subtractPieces(base, minus) {
  const m = mergeIntervals(minus);
  const out = [];
  for (const [a0, b0] of mergeIntervals(base)) {
    let cur = a0;
    for (const [ma, mb] of m) {
      if (mb <= cur + EPS) continue;
      if (ma >= b0 - EPS) break;
      if (ma > cur + EPS) out.push([cur, Math.min(ma, b0)]);
      cur = Math.max(cur, mb);
      if (cur >= b0 - EPS) break;
    }
    if (cur < b0 - EPS) out.push([cur, b0]);
  }
  return mergeIntervals(out);
}

/** 两组线性片段的总重叠长度。 */
function overlapLength(piecesA, piecesB) {
  let total = 0;
  for (const [a, b] of piecesA) {
    for (const [c, d] of piecesB) {
      const s = Math.max(a, c);
      const e = Math.min(b, d);
      if (e - s > EPS) total += e - s;
    }
  }
  return total;
}

/**
 * 线性片段 → 视图段列表。贴零与贴 C 的两段拼回一个跨零段（wraps=true），
 * 整圈表示为 {startMm: 0, endMm: C}。
 */
function piecesToView(pieces, C) {
  const merged = mergeIntervals(pieces);
  if (merged.length === 0) return [];
  const toView = ([a, b]) => ({ startMm: a, endMm: b, wraps: false, widthMm: b - a });
  if (merged.length === 1) {
    const [a, b] = merged[0];
    if (b - a >= C - EPS) return [{ startMm: 0, endMm: C, wraps: false, widthMm: C }];
    return [toView([a, b])];
  }
  const first = merged[0];
  const last = merged[merged.length - 1];
  const joinable = first[0] <= EPS && last[1] >= C - EPS;
  const out = [];
  const lo = joinable ? 1 : 0;
  const hi = joinable ? merged.length - 1 : merged.length;
  for (let i = lo; i < hi; i++) out.push(toView(merged[i]));
  if (joinable) {
    out.push({ startMm: last[0], endMm: first[1], wraps: true, widthMm: C - last[0] + first[1] });
  }
  return out;
}

/** 将一组视图段规范化为圆周上的覆盖段：合并相邻/重叠并拼回跨零段。 */
function canonicalSegs(segs, C) {
  const pieces = [];
  for (const s of segs) pieces.push(...viewToPieces(s, C));
  return piecesToView(pieces, C);
}

/** 圆周上有向距离：从 from 沿正向到 to 的最短偏移，结果在 (-C/2, C/2]。 */
function circDelta(from, to, C) {
  return mod(to - from + C / 2, C) - C / 2;
}

function isFullCircle(seg, C) {
  if (seg.widthMm !== undefined) return seg.widthMm >= C - EPS;
  if (seg.wraps) return false;
  return seg.endMm - seg.startMm >= C - EPS;
}

/**
 * 比较两组圆周覆盖段（a 为基准，b 为对比）：
 * - added / removed：b 相对 a 的圆周区间差集（新增 / 移除）；
 * - moved：按重叠配对的段中边界发生移动的（含起终点有向偏移量）；
 * - unchanged：配对且边界未移动的段（取 b 侧）。
 */
function compareSegmentSets(segsA, segsB, C) {
  const pcsA = segsA.map((s) => viewToPieces(s, C));
  const pcsB = segsB.map((s) => viewToPieces(s, C));
  const flatA = pcsA.reduce((acc, p) => acc.concat(p), []);
  const flatB = pcsB.reduce((acc, p) => acc.concat(p), []);
  const added = piecesToView(subtractPieces(flatB, flatA), C);
  const removed = piecesToView(subtractPieces(flatA, flatB), C);

  const lenOf = (pieces) => pieces.reduce((acc, [a, b]) => acc + (b - a), 0);

  // 贪心配对：按圆周重叠长度从大到小，每段至多配对一次
  const candidates = [];
  pcsA.forEach((pa, i) => {
    pcsB.forEach((pb, j) => {
      const ov = overlapLength(pa, pb);
      if (ov > EPS) candidates.push({ i, j, ov });
    });
  });
  candidates.sort((x, y) => y.ov - x.ov || x.i - y.i || x.j - y.j);

  const usedA = new Set();
  const usedB = new Set();
  const moved = [];
  const unchanged = [];
  for (const { i, j, ov } of candidates) {
    if (usedA.has(i) || usedB.has(j)) continue;
    usedA.add(i);
    usedB.add(j);
    const a = segsA[i];
    const b = segsB[j];
    const fullA = isFullCircle(a, C);
    const fullB = isFullCircle(b, C);
    if (fullA || fullB) {
      // 整圈段无边界可言：两侧皆整圈视为不变，否则交给新增/移除表达
      if (fullA && fullB) unchanged.push(b);
      continue;
    }
    const dStart = circDelta(a.startMm, b.startMm, C);
    const dEnd = circDelta(a.endMm, b.endMm, C);
    if (Math.abs(dStart) <= MOVE_EPS && Math.abs(dEnd) <= MOVE_EPS) {
      unchanged.push(b);
      continue;
    }
    // 重叠需覆盖较长段的一半以上，避免把段的分裂/合并误报为边界移动
    if (ov * 2 < Math.max(lenOf(pcsA[i]), lenOf(pcsB[j])) - EPS) continue;
    moved.push({
      from: { startMm: a.startMm, endMm: a.endMm, wraps: !!a.wraps },
      to: { startMm: b.startMm, endMm: b.endMm, wraps: !!b.wraps },
      startDeltaMm: dStart,
      endDeltaMm: dEnd,
    });
  }
  moved.sort((x, y) => x.from.startMm - y.from.startMm || x.from.endMm - y.from.endMm);
  unchanged.sort((x, y) => x.startMm - y.startMm || x.endMm - y.endMm);
  return { added, removed, moved, unchanged };
}

/**
 * 比较两次 computeSeamAvoidance 的结果（周长需一致），
 * 对保护区、合并禁用段、可行段分别输出圆周区间差异。
 */
function compareResults(resultA, resultB) {
  const C = resultA.circumference;
  const flat = (arr) => arr.reduce((acc, x) => acc.concat(x), []);
  return {
    circumference: C,
    seamWidthA: resultA.seamWidth,
    seamWidthB: resultB.seamWidth,
    zones: compareSegmentSets(
      canonicalSegs(flat(resultA.zonePieces), C),
      canonicalSegs(flat(resultB.zonePieces), C),
      C
    ),
    forbidden: compareSegmentSets(
      canonicalSegs(resultA.forbiddenMerged, C),
      canonicalSegs(resultB.forbiddenMerged, C),
      C
    ),
    feasible: compareSegmentSets(
      canonicalSegs(resultA.feasible, C),
      canonicalSegs(resultB.feasible, C),
      C
    ),
  };
}

module.exports = {
  EPS,
  MOVE_EPS,
  mod,
  mmToDeg,
  normalizeZone,
  forbiddenPieces,
  mergeIntervals,
  computeGaps,
  computeSeamAvoidance,
  viewToPieces,
  subtractPieces,
  piecesToView,
  canonicalSegs,
  circDelta,
  compareSegmentSets,
  compareResults,
};
