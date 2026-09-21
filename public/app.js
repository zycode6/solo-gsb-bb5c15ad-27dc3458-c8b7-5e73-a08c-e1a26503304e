'use strict';

/* 圆筒包装接缝避让前端：参数表单、结果列表、Canvas 预览与拖动吸附 */

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

const state = {
  result: null,        // 服务端计算结果
  thetaMm: 0,          // 当前接缝位置 (mm, [0, C))
  dragging: false,
  rawMm: null,         // 拖动时未吸附的原始角度
  snapshots: [],       // 本地方案快照（localStorage 持久化）
  compareSel: [],      // 待比较的快照 id（最多 2 个）
  diff: null,          // 快照比较结果（含 aName/bName）
  diffIds: [],         // 参与当前比较的快照 id
};

const TAU = Math.PI * 2;
const mod = (n, m) => ((n % m) + m) % m;
const fmtMm = (x) => String(Math.round(x * 100) / 100);
const fmtDeg = (x) => (Math.round(x * 10) / 10).toFixed(1);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- 输入表单 ---------------- */

function addZoneRow(start = '', end = '') {
  const row = document.createElement('div');
  row.className = 'zone-row';
  row.innerHTML = `
    <label>起点 (mm)<input type="number" step="any" class="z-start" value="${start}"></label>
    <label>终点 (mm)<input type="number" step="any" class="z-end" value="${end}"></label>
    <button type="button" class="remove" title="删除">✕</button>`;
  row.querySelector('.remove').addEventListener('click', () => {
    row.remove();
    scheduleCompute();
  });
  row.querySelectorAll('input').forEach((i) => i.addEventListener('input', scheduleCompute));
  $('zones').appendChild(row);
}

function readInputs() {
  const circumference = parseFloat($('circumference').value);
  const seamWidth = parseFloat($('seamWidth').value);
  const zones = [...document.querySelectorAll('.zone-row')].map((row) => ({
    start: parseFloat(row.querySelector('.z-start').value),
    end: parseFloat(row.querySelector('.z-end').value),
  }));
  return { circumference, seamWidth, zones };
}

/* ---------------- 计算 ---------------- */

let computeTimer = null;
function scheduleCompute() {
  clearTimeout(computeTimer);
  computeTimer = setTimeout(compute, 250);
}

async function compute() {
  const body = readInputs();
  $('error').hidden = true;

  if (!Number.isFinite(body.circumference) || body.circumference <= 0) {
    return showError('筒体周长必须为大于 0 的数值');
  }
  if (!Number.isFinite(body.seamWidth) || body.seamWidth < 0) {
    return showError('接缝安全宽度必须为不小于 0 的数值');
  }
  if (body.zones.some((z) => !Number.isFinite(z.start) || !Number.isFinite(z.end))) {
    return showError('保护区的起点与终点必须为数值 (mm)');
  }

  clearDiff(); // 参数变化后回到实时计算视图

  let result;
  try {
    const res = await fetch('/api/compute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    result = await res.json();
    if (!res.ok) return showError(result.error || '计算失败');
  } catch (e) {
    return showError('无法连接服务器：' + e.message);
  }

  state.result = result;
  // 默认选择：距禁用边界最远、角度最小的旋转量
  if (result.best) state.thetaMm = result.best.mm;
  renderResults();
  draw();
}

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = false;
}

/* ---------------- 结果渲染 ---------------- */

function segText(s) {
  if (s.widthDeg !== undefined && s.widthDeg >= 360 - 1e-6) {
    return `0.0° → 360.0°（整圈）`;
  }
  const range = `${fmtDeg(s.startDeg)}° → ${fmtDeg(s.endDeg)}°`;
  const mm = `${fmtMm(s.startMm)} → ${fmtMm(s.endMm)} mm`;
  const wrap = s.wraps ? '（跨零点）' : '';
  return `${range} ｜ ${mm}${wrap}`;
}

function renderResults() {
  const r = state.result;

  const bestBox = $('bestBox');
  if (r.best) {
    bestBox.hidden = false;
    bestBox.innerHTML =
      `默认旋转量（距禁用边界最远、角度最小）：<br>` +
      `<span class="num">${fmtDeg(r.best.deg)}°</span> ＝ ${fmtMm(r.best.mm)} mm`;
  } else {
    bestBox.hidden = true;
  }

  $('noSolutionBox').hidden = !r.noSolution;
  if (r.noSolution) {
    $('chainList').innerHTML = r.forbiddenChain
      .map(
        (c, i) =>
          `<div class="chain-item">链节 ${i + 1}：${fmtDeg(c.startDeg)}° → ${fmtDeg(c.endDeg)}°` +
          `（${fmtMm(c.startMm)} → ${fmtMm(c.endMm)} mm）</div>`
      )
      .join('');
  }

  $('feasibleCount').textContent = r.noSolution ? '（无）' : `（共 ${r.feasible.length} 段）`;
  const fl = $('feasibleList');
  fl.innerHTML = '';
  r.feasible.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'feasible';
    li.innerHTML = `<span>段 ${i + 1}：${segText(s)}</span><span class="tag">宽 ${fmtDeg(s.widthDeg)}°</span>`;
    li.title = '点击将该段中点设为接缝位置';
    li.addEventListener('click', () => {
      const C = r.circumference;
      const sMm = s.startMm;
      const eMm = s.wraps ? s.endMm + C : s.endMm;
      state.thetaMm = mod((sMm + eMm) / 2, C);
      renderResults();
      draw();
    });
    fl.appendChild(li);
  });
  markActiveSegment();

  const dl = $('forbiddenList');
  dl.innerHTML = '';
  if (r.forbiddenMerged.length === 0) {
    dl.innerHTML = '<li class="forbidden">无禁用区间，整圈可行</li>';
  } else {
    r.forbiddenMerged.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = 'forbidden';
      li.innerHTML = `<span>禁用 ${i + 1}：${segText(s)}</span>`;
      dl.appendChild(li);
    });
  }
}

function markActiveSegment() {
  const r = state.result;
  if (!r || r.noSolution) return;
  const C = r.circumference;
  [...$('feasibleList').children].forEach((li, i) => {
    const s = r.feasible[i];
    const eMm = s.wraps ? s.endMm + C : s.endMm;
    const t = state.thetaMm;
    li.classList.toggle('active', (t >= s.startMm && t <= eMm) || (t + C >= s.startMm && t + C <= eMm));
  });
}

/* ---------------- 吸附 ---------------- */

/** 将角度 m (mm) 吸附到最近可行位置；无解时返回 null */
function snapToFeasible(m) {
  const r = state.result;
  if (!r || r.noSolution) return null;
  const C = r.circumference;
  if (r.feasible.length === 0) return null;

  const inGap = (x) =>
    r.feasible.some((s) => {
      const e = s.wraps ? s.endMm + C : s.endMm;
      return (x >= s.startMm && x <= e) || (x + C >= s.startMm && x + C <= e);
    });

  if (inGap(m)) return m;

  let best = null;
  for (const s of r.feasible) {
    const e = s.wraps ? s.endMm + C : s.endMm;
    for (const cand of [mod(s.startMm, C), mod(e, C)]) {
      const d = Math.min(Math.abs(cand - m), C - Math.abs(cand - m));
      if (!best || d < best.d) best = { d, v: cand };
    }
  }
  return best ? best.v : null;
}

/* ---------------- Canvas ---------------- */

function geom() {
  const dpr = window.devicePixelRatio || 1;
  const size = 520;
  if (canvas.width !== size * dpr) {
    canvas.width = size * dpr;
    canvas.height = size * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { cx: size / 2, cy: size / 2, R: 170, size };
}

/** 我们的角度约定：0° 在正上方，顺时针为正；转为 canvas 弧度 */
function rad(mmAngle, C) {
  return (mmAngle / C) * TAU - Math.PI / 2;
}

function arc(cx, cy, r, a0, a1) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a1, false);
  ctx.stroke();
}

function drawRingSegments(cx, cy, r, segments, C, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  for (const s of segments) {
    const span =
      s.widthMm !== undefined ? s.widthMm : (s.wraps ? s.endMm + C : s.endMm) - s.startMm;
    if (span >= C - 1e-9) {
      arc(cx, cy, r, 0, TAU); // 整圈
      continue;
    }
    const a0 = rad(s.startMm, C);
    const a1 = s.wraps ? rad(s.endMm + C, C) : rad(s.endMm, C);
    arc(cx, cy, r, a0, a1);
  }
}

/** 每 30° 的刻度与角度标注 */
function drawTicks(cx, cy, R, C) {
  ctx.strokeStyle = '#d1d5db';
  ctx.fillStyle = '#9ca3af';
  ctx.lineWidth = 1;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let d = 0; d < 360; d += 30) {
    const a = rad((d / 360) * C, C);
    const x1 = cx + (R + 14) * Math.cos(a);
    const y1 = cy + (R + 14) * Math.sin(a);
    const x2 = cx + (R + 22) * Math.cos(a);
    const y2 = cy + (R + 22) * Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.fillText(`${d}°`, cx + (R + 36) * Math.cos(a), cy + (R + 36) * Math.sin(a));
  }
}

function draw() {
  const r = state.result;
  const { cx, cy, R, size } = geom();
  ctx.clearRect(0, 0, size, size);
  if (state.diff) return drawDiff();
  if (!r) return;
  const C = r.circumference;

  // 刻度（每 30°）
  drawTicks(cx, cy, R, C);

  // 外环底色
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 20;
  arc(cx, cy, R, 0, TAU);

  if (r.noSolution) {
    // 无解：整圈禁用区间链
    drawRingSegments(cx, cy, R, r.forbiddenChain, C, '#d43a3a', 20);
  } else {
    drawRingSegments(cx, cy, R, r.feasible, C, '#1e9e50', 20);
    drawRingSegments(cx, cy, R, r.forbiddenMerged, C, '#d43a3a', 20);
  }

  // 印刷保护区（内环）
  const zoneSegs = [];
  for (const pieces of r.zonePieces) {
    for (const p of pieces) zoneSegs.push({ startMm: p.startMm, endMm: p.endMm, wraps: false });
  }
  ctx.globalAlpha = 0.9;
  drawRingSegments(cx, cy, R - 34, zoneSegs, C, '#e8912d', 12);
  ctx.globalAlpha = 1;

  // 接缝扇形（宽度 = 接缝安全宽度）
  const theta = state.thetaMm;
  const a0 = rad(theta, C);
  const a1 = rad(theta + r.seamWidth, C);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, R - 46, a0, a1, false);
  ctx.closePath();
  ctx.fillStyle = r.noSolution ? 'rgba(212,58,58,0.18)' : 'rgba(37,99,235,0.18)';
  ctx.fill();

  // 接缝位置线
  ctx.strokeStyle = r.noSolution ? '#d43a3a' : '#2563eb';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx + (R - 46) * Math.cos(a0), cy + (R - 46) * Math.sin(a0));
  ctx.lineTo(cx + (R + 26) * Math.cos(a0), cy + (R + 26) * Math.sin(a0));
  ctx.stroke();

  // 拖动时未吸附的原始位置（虚线）
  if (state.dragging && state.rawMm !== null && Math.abs(mod(state.rawMm - theta + C / 2, C) - C / 2) > C / 720) {
    const ar = rad(state.rawMm, C);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#9ca3af';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx + (R - 46) * Math.cos(ar), cy + (R - 46) * Math.sin(ar));
    ctx.lineTo(cx + (R + 26) * Math.cos(ar), cy + (R + 26) * Math.sin(ar));
    ctx.stroke();
    ctx.restore();
  }

  // 最优位置标记
  if (r.best) {
    const ab = rad(r.best.mm, C);
    const bx = cx + (R + 10) * Math.cos(ab);
    const by = cy + (R + 10) * Math.sin(ab);
    ctx.fillStyle = '#065f46';
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - 6 * Math.cos(ab - 0.35), by - 6 * Math.sin(ab - 0.35));
    ctx.lineTo(bx - 6 * Math.cos(ab + 0.35), by - 6 * Math.sin(ab + 0.35));
    ctx.closePath();
    ctx.fill();
  }

  // 中心文字
  ctx.fillStyle = '#1f2937';
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (r.noSolution) {
    ctx.fillStyle = '#d43a3a';
    ctx.fillText('无解', cx, cy - 12);
    ctx.font = '13px sans-serif';
    ctx.fillText('禁用区间覆盖整圈', cx, cy + 14);
  } else {
    ctx.fillText(`${fmtDeg((theta / C) * 360)}°`, cx, cy - 10);
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#6b7280';
    ctx.fillText(`${fmtMm(theta)} mm`, cx, cy + 14);
  }

  // 图例
  const legend = r.noSolution
    ? [['#d43a3a', '禁用（覆盖整圈）'], ['#e8912d', '印刷保护区']]
    : [['#1e9e50', '可行'], ['#d43a3a', '禁用'], ['#e8912d', '印刷保护区'], ['#2563eb', '接缝']];
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  let lx = 16;
  for (const [color, label] of legend) {
    ctx.fillStyle = color;
    ctx.fillRect(lx, size - 22, 12, 12);
    ctx.fillStyle = '#374151';
    ctx.fillText(label, lx + 16, size - 15);
    lx += 16 + ctx.measureText(label).width + 18;
  }

  // 当前位置文字
  const deg = fmtDeg((theta / C) * 360);
  $('currentPos').textContent = r.noSolution
    ? '当前无可行位置：请缩小接缝宽度或调整保护区'
    : `当前接缝位置：${deg}°（${fmtMm(theta)} mm）`;
  markActiveSegment();
}

/* ---------------- 拖动 ---------------- */

function pointerMm(ev) {
  const rect = canvas.getBoundingClientRect();
  const { cx, cy, size } = geom();
  const scale = size / rect.width;
  const x = (ev.clientX - rect.left) * scale - cx;
  const y = (ev.clientY - rect.top) * scale - cy;
  const C = state.result.circumference;
  return mod((Math.atan2(x, -y) / TAU) * C, C);
}

canvas.addEventListener('pointerdown', (ev) => {
  if (!state.result || state.diff) return; // 比较视图下禁用拖动
  state.dragging = true;
  canvas.classList.add('dragging');
  canvas.setPointerCapture(ev.pointerId);
  state.rawMm = pointerMm(ev);
  const snapped = snapToFeasible(state.rawMm);
  if (snapped !== null) state.thetaMm = snapped;
  draw();
});
canvas.addEventListener('pointermove', (ev) => {
  if (!state.dragging) return;
  state.rawMm = pointerMm(ev);
  const snapped = snapToFeasible(state.rawMm);
  if (snapped !== null) state.thetaMm = snapped;
  draw();
});
function endDrag() {
  state.dragging = false;
  state.rawMm = null;
  canvas.classList.remove('dragging');
  draw();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

/* ---------------- 方案快照（localStorage 持久化） ---------------- */

const LS_KEY = 'seamSnapshots.v1';

function loadSnapshots() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (s) =>
        s &&
        typeof s.id === 'string' &&
        typeof s.name === 'string' &&
        Number.isFinite(s.createdAt) &&
        s.inputs &&
        Number.isFinite(s.inputs.circumference) &&
        Number.isFinite(s.inputs.seamWidth) &&
        Array.isArray(s.inputs.zones)
    );
  } catch {
    return [];
  }
}

function persistSnapshots() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state.snapshots));
  } catch {
    showError('快照无法写入本地存储（localStorage 不可用）');
  }
}

function snapshotMeta(s) {
  const t = new Date(s.createdAt).toLocaleString('zh-CN', { hour12: false });
  const z = s.inputs.zones.length;
  return `${t} ｜ 周长 ${fmtMm(s.inputs.circumference)} ｜ 缝宽 ${fmtMm(s.inputs.seamWidth)} ｜ 保护区 ${z} 个`;
}

function renderSnapshots() {
  const list = $('snapshotList');
  list.innerHTML = '';
  const sorted = state.snapshots.slice().sort((a, b) => b.createdAt - a.createdAt);
  if (sorted.length === 0) {
    const li = document.createElement('li');
    li.className = 'snapshot-empty';
    li.textContent = '暂无快照：完成计算后可在上方命名并保存当前方案';
    list.appendChild(li);
  }
  for (const s of sorted) {
    const li = document.createElement('li');
    li.className = 'snapshot-item' + (state.compareSel.includes(s.id) ? ' selected' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.compareSel.includes(s.id);
    cb.title = '勾选两个快照进行比较';
    cb.addEventListener('change', () => toggleSelect(s.id, cb));

    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = s.name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = snapshotMeta(s);
    info.appendChild(name);
    info.appendChild(meta);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.textContent = '✕';
    del.title = '删除快照';
    del.addEventListener('click', () => deleteSnapshot(s.id));

    li.appendChild(cb);
    li.appendChild(info);
    li.appendChild(del);
    list.appendChild(li);
  }
  updateCompareBar();
}

function updateCompareBar() {
  $('compareBtn').disabled = state.compareSel.length !== 2;
  $('compareHint').textContent = `已选 ${state.compareSel.length}/2 个快照`;
}

function toggleSelect(id, cb) {
  if (cb.checked) {
    if (state.compareSel.length >= 2) {
      cb.checked = false;
      $('compareHint').textContent = '最多同时选择两个快照进行比较';
      return;
    }
    state.compareSel.push(id);
  } else {
    state.compareSel = state.compareSel.filter((x) => x !== id);
  }
  renderSnapshots();
}

function saveSnapshot() {
  const body = readInputs();
  if (!Number.isFinite(body.circumference) || body.circumference <= 0) {
    return showError('筒体周长必须为大于 0 的数值，无法保存快照');
  }
  if (!Number.isFinite(body.seamWidth) || body.seamWidth < 0) {
    return showError('接缝安全宽度必须为不小于 0 的数值，无法保存快照');
  }
  if (body.zones.some((z) => !Number.isFinite(z.start) || !Number.isFinite(z.end))) {
    return showError('保护区的起点与终点必须为数值 (mm)，无法保存快照');
  }
  $('error').hidden = true;

  const name =
    $('snapName').value.trim() || `快照 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
  state.snapshots.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    name,
    createdAt: Date.now(),
    inputs: JSON.parse(JSON.stringify(body)),
  });
  persistSnapshots();
  $('snapName').value = '';
  renderSnapshots();
}

function deleteSnapshot(id) {
  state.snapshots = state.snapshots.filter((s) => s.id !== id);
  state.compareSel = state.compareSel.filter((x) => x !== id);
  persistSnapshots();
  if (state.diffIds.includes(id)) {
    clearDiff();
    draw();
  }
  renderSnapshots();
}

function clearDiff() {
  state.diff = null;
  state.diffIds = [];
  $('diffResults').hidden = true;
  $('exitCompare').hidden = true;
}

/* ---------------- 快照比较 ---------------- */

async function compareSelected() {
  const picked = state.compareSel
    .map((id) => state.snapshots.find((s) => s.id === id))
    .filter(Boolean);
  if (picked.length !== 2) return;
  // 时间较早的作为基准 a，较新的作为对比 b
  const [a, b] = picked[0].createdAt <= picked[1].createdAt ? picked : [picked[1], picked[0]];

  $('error').hidden = true;
  let data;
  try {
    const res = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: a.inputs, b: b.inputs }),
    });
    data = await res.json();
    if (!res.ok) return showError(data.error || '比较失败');
  } catch (e) {
    return showError('无法连接服务器：' + e.message);
  }

  state.diff = data;
  state.diff.aName = a.name;
  state.diff.bName = b.name;
  state.diffIds = [a.id, b.id];
  renderDiff();
  $('exitCompare').hidden = false;
  draw();
}

const DIFF_CATS = [
  ['zones', '印刷保护区'],
  ['forbidden', '禁用区间（合并后）'],
  ['feasible', '可行角度段'],
];

function diffSegText(s, C) {
  if (s.widthMm !== undefined && s.widthMm >= C - 1e-9) return '整圈';
  const deg = (mm) => fmtDeg((mm / C) * 360);
  const range = `${deg(s.startMm)}° → ${deg(s.endMm)}°`;
  const mm = `${fmtMm(s.startMm)} → ${fmtMm(s.endMm)} mm`;
  return `${range} ｜ ${mm}${s.wraps ? '（跨零点）' : ''}`;
}

const fmtDelta = (d) => (d > 0 ? '+' : '') + fmtMm(d);

function renderDiff() {
  const d = state.diff;
  const box = $('diffResults');
  if (!d) {
    box.hidden = true;
    return;
  }
  const C = d.circumference;
  const seamNote =
    Math.abs(d.seamWidthA - d.seamWidthB) > 1e-9
      ? `，接缝宽度 ${fmtMm(d.seamWidthA)} → ${fmtMm(d.seamWidthB)} mm`
      : `，接缝宽度 ${fmtMm(d.seamWidthA)} mm`;
  let html =
    `<div class="diff-head">基准「${esc(d.aName)}」→ 对比「${esc(d.bName)}」` +
    `（周长 ${fmtMm(C)} mm${seamNote}）</div><div class="diff-cats">`;
  let allEmpty = true;
  for (const [key, title] of DIFF_CATS) {
    const c = d[key];
    const empty = c.added.length === 0 && c.removed.length === 0 && c.moved.length === 0;
    if (!empty) allEmpty = false;
    html += `<div class="diff-cat"><h3>${title}</h3>`;
    if (empty) {
      html += '<div class="diff-none">无差异</div>';
    } else {
      for (const m of c.moved) {
        const parts = [];
        if (Math.abs(m.startDeltaMm) > 1e-9) parts.push(`起点 ${fmtDelta(m.startDeltaMm)} mm`);
        if (Math.abs(m.endDeltaMm) > 1e-9) parts.push(`终点 ${fmtDelta(m.endDeltaMm)} mm`);
        html +=
          `<div class="diff-item moved">↔ ${diffSegText(m.from, C)}<br>` +
          `⇒ ${diffSegText(m.to, C)}（${parts.join('，')}）</div>`;
      }
      for (const s of c.added) html += `<div class="diff-item added">＋ ${diffSegText(s, C)}</div>`;
      for (const s of c.removed) html += `<div class="diff-item removed">－ ${diffSegText(s, C)}</div>`;
    }
    html += '</div>';
  }
  html += '</div>';
  if (allEmpty) html += '<div class="diff-none">两个快照的计算结果完全一致</div>';
  box.innerHTML = html;
  box.hidden = false;
}

/* ---------------- 比较视图 Canvas ---------------- */

/** 在指定环上画一条径向边界刻度线 */
function boundaryTick(cx, cy, r, w, mm, C, color, dashed) {
  const a = rad(mm, C);
  ctx.save();
  if (dashed) ctx.setLineDash([3, 3]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx + (r - w / 2 - 3) * Math.cos(a), cy + (r - w / 2 - 3) * Math.sin(a));
  ctx.lineTo(cx + (r + w / 2 + 3) * Math.cos(a), cy + (r + w / 2 + 3) * Math.sin(a));
  ctx.stroke();
  ctx.restore();
}

/** 快照比较视图：三环分别高亮可行段 / 禁用段 / 保护区的新增、移除与边界移动 */
function drawDiff() {
  const d = state.diff;
  const { cx, cy, R, size } = geom();
  const C = d.circumference;
  drawTicks(cx, cy, R, C);

  const rings = [
    { key: 'feasible', r: R, w: 18 },
    { key: 'forbidden', r: R - 28, w: 18 },
    { key: 'zones', r: R - 52, w: 12 },
  ];
  for (const { r, w } of rings) {
    ctx.strokeStyle = '#f3f4f6';
    ctx.lineWidth = w;
    arc(cx, cy, r, 0, TAU);
  }
  for (const { key, r, w } of rings) {
    const cat = d[key];
    ctx.globalAlpha = 0.4;
    drawRingSegments(cx, cy, r, cat.unchanged, C, '#9ca3af', w);
    ctx.globalAlpha = 1;
    drawRingSegments(cx, cy, r, cat.removed, C, '#d43a3a', w);
    drawRingSegments(cx, cy, r, cat.added, C, '#1e9e50', w);
    for (const m of cat.moved) {
      // 蓝色细弧为移动后的段，虚线刻度为原边界、实线刻度为新边界
      drawRingSegments(cx, cy, r, [m.to], C, '#2563eb', Math.max(4, w - 8));
      boundaryTick(cx, cy, r, w, m.from.startMm, C, '#9ca3af', true);
      boundaryTick(cx, cy, r, w, m.from.endMm, C, '#9ca3af', true);
      boundaryTick(cx, cy, r, w, m.to.startMm, C, '#2563eb', false);
      boundaryTick(cx, cy, r, w, m.to.endMm, C, '#2563eb', false);
    }
  }

  // 中心文字
  const short = (s) => (s.length > 12 ? s.slice(0, 12) + '…' : s);
  ctx.fillStyle = '#1f2937';
  ctx.font = 'bold 20px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('快照比较', cx, cy - 14);
  ctx.font = '13px sans-serif';
  ctx.fillStyle = '#6b7280';
  ctx.fillText(`「${short(d.aName)}」→「${short(d.bName)}」`, cx, cy + 12);

  // 图例与环说明
  const legend = [
    ['#1e9e50', '新增'],
    ['#d43a3a', '移除'],
    ['#2563eb', '边界移动'],
    ['#9ca3af', '不变'],
  ];
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  let lx = 16;
  for (const [color, label] of legend) {
    ctx.fillStyle = color;
    ctx.fillRect(lx, size - 22, 12, 12);
    ctx.fillStyle = '#374151';
    ctx.fillText(label, lx + 16, size - 15);
    lx += 16 + ctx.measureText(label).width + 18;
  }
  ctx.fillStyle = '#6b7280';
  ctx.fillText('外环＝可行段　中环＝禁用段　内环＝保护区', 16, size - 40);

  $('currentPos').textContent = `正在比较「${d.aName}」→「${d.bName}」，点击“退出比较”返回实时计算`;
}

/* ---------------- 初始化 ---------------- */

$('addZone').addEventListener('click', () => {
  addZoneRow();
  scheduleCompute();
});
$('compute').addEventListener('click', compute);
$('circumference').addEventListener('input', scheduleCompute);
$('seamWidth').addEventListener('input', scheduleCompute);
$('loadExample').addEventListener('click', () => {
  $('circumference').value = 400;
  $('seamWidth').value = 20;
  $('zones').innerHTML = '';
  addZoneRow(60, 120);
  addZoneRow(200, 260);
  addZoneRow(350, 30); // 跨零点保护区
  compute();
});
window.addEventListener('resize', draw);

// 快照面板
$('saveSnapshot').addEventListener('click', saveSnapshot);
$('compareBtn').addEventListener('click', compareSelected);
$('exitCompare').addEventListener('click', () => {
  clearDiff();
  draw();
});
state.snapshots = loadSnapshots();
renderSnapshots();

// 默认载入示例并计算
$('loadExample').click();
