const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const os = require('os');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Supabase 初始化 ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── 默认初始数据 ──
function getInitData() {
  return {
    sales: [], payments: [], purchases: [], earlyPayments: [], expenses: [], nextId: 1001,
    phones: [
      { id: 1, brand: 'Apple', model: 'iPhone 16', cost: 700, price: 950, stock: 5 },
      { id: 2, brand: 'Apple', model: 'iPhone 15 Pro', cost: 820, price: 1099, stock: 3 },
      { id: 3, brand: 'Apple', model: 'iPhone 15', cost: 620, price: 849, stock: 6 },
      { id: 4, brand: 'Apple', model: 'iPhone 14', cost: 490, price: 699, stock: 4 },
      { id: 5, brand: 'Samsung', model: 'Galaxy S24 Ultra', cost: 700, price: 950, stock: 2 },
    ],
    suppliers: [
      { id: 1, name: '金源通讯', contact: '张先生', phone: '012-345678', address: '金边市中心' },
      { id: 2, name: '速达电子', contact: '李女士', phone: '013-456789', address: '西哈努克省' },
    ],
    company: { name: 'MORODOK', address: '金边市', phone: '012-000000', note: '' }
  };
}

// ── 读取所有数据 ──
async function loadData() {
  try {
    const { data, error } = await supabase
      .from('appdata')
      .select('key, value');

    if (error || !data || data.length === 0) {
      console.log('数据库为空，使用初始数据');
      return getInitData();
    }

    const result = {};
    data.forEach(row => { result[row.key] = row.value; });

    // 补充缺失的字段
    const init = getInitData();
    Object.keys(init).forEach(k => {
      if (result[k] === undefined) result[k] = init[k];
    });

    return result;
  } catch (e) {
    console.error('读取数据失败:', e.message);
    return getInitData();
  }
}

// ── 保存所有数据 ──
async function saveData(dbData) {
  const rows = Object.entries(dbData).map(([key, value]) => ({ key, value }));
  const { error } = await supabase
    .from('appdata')
    .upsert(rows, { onConflict: 'key' });
  if (error) throw error;
}

// ── API 路由 ──

// 获取所有数据
app.get('/api/data', async (req, res) => {
  try {
    const data = await loadData();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 保存所有数据
app.post('/api/data', async (req, res) => {
  try {
    await saveData(req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 单独更新某个集合
app.post('/api/:collection', async (req, res) => {
  try {
    const { collection } = req.params;
    const allowed = ['sales','payments','phones','suppliers','purchases','company','nextId','earlyPayments','expenses'];
    if (!allowed.includes(collection)) return res.status(400).json({ ok: false });

    const { error } = await supabase
      .from('appdata')
      .upsert([{ key: collection, value: req.body.value }], { onConflict: 'key' });

    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 数据备份下载
app.get('/api/backup', async (req, res) => {
  try {
    const data = await loadData();
    data.exportedAt = new Date().toISOString();
    res.setHeader('Content-Disposition', `attachment; filename=MORODOK_backup_${new Date().toISOString().slice(0,10)}.json`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 健康检查
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── 启动 ──
app.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  let localIP = 'localhost';
  Object.values(interfaces).forEach(iface => {
    (iface||[]).forEach(addr => {
      if (addr.family === 'IPv4' && !addr.internal) localIP = addr.address;
    });
  });

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   📱 MORODOK 手机分期管理系统 — 云端版        ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║   访问地址：http://localhost:${PORT}              ║`);
  console.log(`║   局域网：  http://${localIP}:${PORT}      ║`);
  console.log('║   数据存储：Supabase 云端数据库               ║');
  console.log('╚══════════════════════════════════════════════╝\n');
});
