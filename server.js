'use strict';

const path = require('path');
const express = require('express');
const { computeSeamAvoidance, compareResults } = require('./src/seamMath');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MAX_ZONES = 200;

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

/** 校验接缝避让计算入参，返回错误信息或 null */
function validateComputeInputs(body) {
  if (!body || typeof body !== 'object') return '请求体必须为 JSON 对象';
  const { circumference, seamWidth, zones } = body;
  if (!isFiniteNumber(circumference) || circumference <= 0) {
    return 'circumference 必须为大于 0 的数值 (mm)';
  }
  if (!isFiniteNumber(seamWidth) || seamWidth < 0) {
    return 'seamWidth 必须为不小于 0 的数值 (mm)';
  }
  if (!Array.isArray(zones) || zones.length > MAX_ZONES) {
    return `zones 必须为数组，且不超过 ${MAX_ZONES} 个`;
  }
  for (const [i, z] of zones.entries()) {
    if (!z || !isFiniteNumber(z.start) || !isFiniteNumber(z.end)) {
      return `zones[${i}] 需要数值类型的 start 与 end (mm)`;
    }
  }
  return null;
}

app.post('/api/compute', (req, res) => {
  const err = validateComputeInputs(req.body);
  if (err) return res.status(400).json({ error: err });
  const { circumference, seamWidth, zones } = req.body;
  res.json(computeSeamAvoidance(circumference, seamWidth, zones));
});

/**
 * 快照比较：a 为基准、b 为对比，两者周长必须一致。
 * 按圆周区间输出保护区、合并禁用段与可行段的新增、移除及边界移动。
 */
app.post('/api/compare', (req, res) => {
  const body = req.body || {};
  const errA = validateComputeInputs(body.a);
  if (errA) return res.status(400).json({ error: `基准快照：${errA}` });
  const errB = validateComputeInputs(body.b);
  if (errB) return res.status(400).json({ error: `对比快照：${errB}` });

  const ra = computeSeamAvoidance(body.a.circumference, body.a.seamWidth, body.a.zones);
  const rb = computeSeamAvoidance(body.b.circumference, body.b.seamWidth, body.b.zones);
  if (Math.abs(ra.circumference - rb.circumference) > 1e-9 * Math.max(1, ra.circumference)) {
    return res.status(400).json({ error: '两个快照的筒体周长不同，无法按圆周区间比较' });
  }
  res.json(compareResults(ra, rb));
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`seam-avoidance app listening on http://0.0.0.0:${PORT}`);
});
