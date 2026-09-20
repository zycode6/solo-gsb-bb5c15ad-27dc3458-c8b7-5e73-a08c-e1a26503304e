'use strict';

const path = require('path');
const express = require('express');
const { computeSeamAvoidance } = require('./src/seamMath');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MAX_ZONES = 200;

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));
// 前端直接复用 src 下的 UMD 差异算法
app.use('/src', express.static(path.join(__dirname, 'src')));

function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

app.post('/api/compute', (req, res) => {
  const body = req.body || {};
  const { circumference, seamWidth, zones } = body;

  if (!isFiniteNumber(circumference) || circumference <= 0) {
    return res.status(400).json({ error: 'circumference 必须为大于 0 的数值 (mm)' });
  }
  if (!isFiniteNumber(seamWidth) || seamWidth < 0) {
    return res.status(400).json({ error: 'seamWidth 必须为不小于 0 的数值 (mm)' });
  }
  if (!Array.isArray(zones) || zones.length > MAX_ZONES) {
    return res.status(400).json({ error: `zones 必须为数组，且不超过 ${MAX_ZONES} 个` });
  }
  for (const [i, z] of zones.entries()) {
    if (!z || !isFiniteNumber(z.start) || !isFiniteNumber(z.end)) {
      return res.status(400).json({ error: `zones[${i}] 需要数值类型的 start 与 end (mm)` });
    }
  }

  const result = computeSeamAvoidance(circumference, seamWidth, zones);
  res.json(result);
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`seam-avoidance app listening on http://0.0.0.0:${PORT}`);
});
