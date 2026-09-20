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
};

const TAU = Math.PI * 2;
const mod = (n, m) => ((n % m) + m) % m;
const fmtMm = (x) => String(Math.round(x * 100) / 100);
const fmtDeg = (x) => (Math.round(x * 10) / 10).toFixed(1);

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

function draw() {
  const r = state.result;
  const { cx, cy, R, size } = geom();
  ctx.clearRect(0, 0, size, size);
  if (!r) return;
  const C = r.circumference;

  // 刻度（每 30°）
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
  if (!state.result) return;
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

// 默认载入示例并计算
$('loadExample').click();
