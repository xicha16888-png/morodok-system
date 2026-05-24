const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const os = require('os');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS 跨域支持（允许导入工具从本地访问）──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ── Supabase 初始化 ──
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();

console.log('SUPABASE_URL:', SUPABASE_URL ? SUPABASE_URL.substring(0, 30) + '...' : '❌ 未设置');
console.log('SUPABASE_KEY:', SUPABASE_KEY ? SUPABASE_KEY.substring(0, 20) + '...' : '❌ 未设置');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

    if (error) {
      console.error('❌ 读取数据库失败:', error.message, error.code);
      throw new Error('DB_READ_ERROR: ' + error.message);
    }

    if (!data || data.length === 0) {
      console.log('📭 数据库为空，初始化默认数据');
      const init = getInitData();
      // 自动写入初始数据到Supabase
      const rows = Object.entries(init).map(([key, value]) => ({ key, value }));
      await supabase.from('appdata').upsert(rows, { onConflict: 'key' });
      return init;
    }

    console.log(`✅ 成功读取 ${data.length} 条记录`);
    const result = {};
    data.forEach(row => { result[row.key] = row.value; });
    const init = getInitData();
    Object.keys(init).forEach(k => { if (result[k] === undefined) result[k] = init[k]; });
    return result;
  } catch (e) {
    console.error('❌ loadData 异常:', e.message);
    throw e; // 向上抛出，让路由返回500
  }
}

// ── 保存所有数据 ──
async function saveData(dbData) {
  const rows = Object.entries(dbData).map(([key, value]) => ({ key, value }));
  const { error } = await supabase
    .from('appdata')
    .upsert(rows, { onConflict: 'key' });
  if (error) {
    console.error('❌ 保存数据失败:', error.message, error.code);
    throw error;
  }
  console.log(`✅ 成功保存 ${rows.length} 条记录`);
}

// ── API 路由 ──
app.get('/api/data', async (req, res) => {
  try {
    const data = await loadData();
    if (!data || typeof data !== 'object') {
      return res.status(500).json({ error: 'DATA_INVALID', message: '数据格式无效' });
    }
    // 自动修正 null 字段，防止前端崩溃
    const arrKeys = ['sales','payments','phones','suppliers','purchases','earlyPayments','expenses'];
    arrKeys.forEach(k => { if (!Array.isArray(data[k])) data[k] = []; });
    if (!data.nextId) data.nextId = 1001;
    if (!data.company || typeof data.company !== 'object') {
      data.company = {name:'MORODOK',address:'',phone:'',note:''};
    }
    res.json(data);
  } catch (e) {
    console.error('GET /api/data 失败:', e.message);
    res.status(500).json({ error: 'DB_ERROR', message: e.message });
  }
});

app.post('/api/data', async (req, res) => {
  try {
    await saveData(req.body);
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/data 失败:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/:collection', async (req, res) => {
  try {
    const { collection } = req.params;
    const allowed = ['sales','payments','phones','suppliers','purchases','company','nextId','earlyPayments','expenses'];
    if (!allowed.includes(collection)) return res.status(400).json({ ok: false, error: '不允许的集合' });
    const { error } = await supabase
      .from('appdata')
      .upsert([{ key: collection, value: req.body.value }], { onConflict: 'key' });
    if (error) {
      console.error(`❌ 保存 ${collection} 失败:`, error.message, error.code);
      throw error;
    }
    console.log(`✅ 保存 ${collection} 成功`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 数据库连接测试
app.get('/api/test', async (req, res) => {
  try {
    const { data, error } = await supabase.from('appdata').select('key').limit(1);
    if (error) return res.json({ ok: false, error: error.message, code: error.code });
    res.json({ ok: true, message: '数据库连接正常', rows: data?.length || 0 });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

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

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── 启动 ──
app.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  let localIP = 'localhost';
  Object.values(interfaces).forEach(iface => {
    (iface || []).forEach(addr => {
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
