const express = require('express');
const compression = require('compression');
const { createClient } = require('@supabase/supabase-js');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// 🚀 性能：index.html 本身已经不小（几百KB的前端代码），加上 /api/data 返回的全部合同+
// 还款记录，以前都是没压缩、原样直接传给浏览器的。这里加上压缩，文字类内容（HTML/JS/JSON）
// 一般能压缩掉70-80%的体积，网络越差（比如手机流量）感受越明显，打开网页、拉取数据都会
// 快不少，不需要动前端一行代码
app.use(compression());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log('SUPABASE_URL:', SUPABASE_URL ? SUPABASE_URL.substring(0, 30) + '...' : '❌ 未设置');
console.log('SUPABASE_KEY:', SUPABASE_KEY ? SUPABASE_KEY.substring(0, 20) + '...' : '❌ 未设置');

// 🚀 性能：数据量大了以后，/api/data 每次返回的都是全部合同+全部还款记录，可能好几MB。
// 但前端每15秒就轮询一次看数据有没有变化——如果每次轮询都拉一次全量数据，等于常年在后台
// 跑大流量，手机网络越差越明显，还会跟用户当下正在做的操作抢带宽，感觉像是"卡顿"。
// 这里加一个内存里的版本号：谁写了数据（saveData成功后）版本号就变一次；前端轮询先问一下
// 这个很小的版本号接口，版本没变就直接跳过，不用再拉一次全量数据。
let _dataVersion = Date.now();

function getInitData() {
  return {
    sales: [], payments: [], purchases: [], earlyPayments: [], expenses: [], stores: [], nextId: 1001,
    phones: [
      { id: 1, brand: 'Apple', model: 'iPhone 16', cost: 700, price: 950, stock: 5 },
      { id: 2, brand: 'Apple', model: 'iPhone 15 Pro', cost: 820, price: 1099, stock: 3 },
      { id: 3, brand: 'Apple', model: 'iPhone 15', cost: 620, price: 849, stock: 6 },
      { id: 4, brand: 'Apple', model: 'iPhone 14', cost: 490, price: 699, stock: 4 },
    ],
    suppliers: [
      { id: 1, name: '金源通讯', contact: '张先生', phone: '012-345678', address: '金边市中心' },
    ],
    company: { name: 'MORODOK', address: '金边市', phone: '012-000000', note: '' }
  };
}

// ── 读取所有数据（分块存储版）──
// 🚀 性能：数据量大了以后（现在合同+还款记录已经上万行），一页一页顺序等下去很慢——
// 先读第一页，如果刚好读满说明后面还有，用 count 查一下总共多少页，再一次性并行把剩下的页都发出去，
// 不用一页等完了才发下一页，大幅缩短这个接口的响应时间。
async function loadData() {
  try {
    const pageSize = 1000;
    let allData = [];
    const first = await supabase.from('appdata').select('key, value').range(0, pageSize - 1);
    if (first.error) throw new Error('DB_READ_ERROR: ' + first.error.message);
    allData = allData.concat(first.data || []);
    if ((first.data || []).length === pageSize) {
      const { count, error: countErr } = await supabase
        .from('appdata')
        .select('key', { count: 'exact', head: true });
      if (countErr) throw new Error('DB_READ_ERROR: ' + countErr.message);
      const totalPages = Math.ceil((count || 0) / pageSize);
      const pagePromises = [];
      for (let p = 1; p < totalPages; p++) {
        const from = p * pageSize;
        pagePromises.push(supabase.from('appdata').select('key, value').range(from, from + pageSize - 1));
      }
      const results = await Promise.all(pagePromises);
      for (const r of results) {
        if (r.error) throw new Error('DB_READ_ERROR: ' + r.error.message);
        allData = allData.concat(r.data || []);
      }
    }

    if (allData.length === 0) {
      console.log('📭 数据库为空，初始化默认数据');
      const init = getInitData();
      await saveData(init);
      return init;
    }

    console.log(`✅ 成功读取 ${allData.length} 条记录`);

    // 重建数据结构：sale_XXX 合并为 sales 数组
    const result = {};
    const salesMap = {};
    const paymentsMap = {};
    const earlyMap = {};

    allData.forEach(row => {
      if (row.key.startsWith('sale_')) {
        salesMap[row.key] = row.value;
      } else if (row.key.startsWith('pay_')) {
        paymentsMap[row.key] = row.value;
      } else if (row.key.startsWith('ep_')) {
        earlyMap[row.key] = row.value;
      } else {
        result[row.key] = row.value;
      }
    });

    // 合并 sales
    if (Object.keys(salesMap).length > 0) {
      result.sales = Object.values(salesMap).sort((a, b) =>
        (a.date || '').localeCompare(b.date || '')
      );
    }
    // 合并 payments
    if (Object.keys(paymentsMap).length > 0) {
      result.payments = Object.values(paymentsMap);
    }
    // 合并 earlyPayments
    if (Object.keys(earlyMap).length > 0) {
      result.earlyPayments = Object.values(earlyMap);
    }

    const init = getInitData();
    Object.keys(init).forEach(k => { if (result[k] === undefined) result[k] = init[k]; });
    return result;
  } catch (e) {
    console.error('❌ loadData 异常:', e.message);
    throw e;
  }
}

// ── 保存所有数据（分块存储版）──
async function saveData(dbData) {
  const rows = [];

  // sales: 每条合同单独一行 key=sale_XXX
  if (Array.isArray(dbData.sales)) {
    dbData.sales.forEach(sale => {
      if (sale && sale.id) {
        rows.push({ key: `sale_${sale.id}`, value: sale });
      }
    });
  }

  // payments: 每条还款记录单独一行 key=pay_XXX
  if (Array.isArray(dbData.payments)) {
    dbData.payments.forEach(pay => {
      if (pay && pay.id) {
        rows.push({ key: `pay_${pay.id}`, value: pay });
      }
    });
  }

  // earlyPayments: 每条提前还款单独一行 key=ep_XXX
  if (Array.isArray(dbData.earlyPayments)) {
    dbData.earlyPayments.forEach(ep => {
      if (ep && ep.id) {
        rows.push({ key: `ep_${ep.id}`, value: ep });
      }
    });
  }

  // 其他字段正常存储
  const skipKeys = new Set(['sales', 'payments', 'earlyPayments']);
  Object.entries(dbData).forEach(([key, value]) => {
    if (!skipKeys.has(key)) {
      rows.push({ key, value });
    }
  });

  // 去重：同一批次内不能有重复key
  const uniqueRows = [];
  const seenKeys = new Set();
  for (const row of rows) {
    if (!seenKeys.has(row.key)) {
      seenKeys.add(row.key);
      uniqueRows.push(row);
    }
  }

  // 分批写入，每批100条
  const batchSize = 100;
  for (let i = 0; i < uniqueRows.length; i += batchSize) {
    const batch = uniqueRows.slice(i, i + batchSize);
    const { error } = await supabase
      .from('appdata')
      .upsert(batch, { onConflict: 'key' });
    if (error) {
      console.error(`❌ 保存批次 ${i}-${i+batchSize} 失败:`, error.message);
      throw error;
    }
  }
  console.log(`✅ 成功保存 ${uniqueRows.length} 条记录（去重前${rows.length}条）`);
  _dataVersion = Date.now();
}

// ── 删除单条合同 ──
async function deleteSale(id) {
  const { error } = await supabase
    .from('appdata')
    .delete()
    .eq('key', `sale_${id}`);
  if (error) throw error;
  _dataVersion = Date.now();
}

// ── 删除单条还款记录 ──
async function deletePayment(id) {
  const { error } = await supabase
    .from('appdata')
    .delete()
    .eq('key', `pay_${id}`);
  if (error) throw error;
  _dataVersion = Date.now();
}

// ── 删除单条提前还款记录 ──
async function deleteEarlyPayment(id) {
  const { error } = await supabase
    .from('appdata')
    .delete()
    .eq('key', `ep_${id}`);
  if (error) throw error;
  _dataVersion = Date.now();
}

// ── API 路由 ──
// 🚀 轻量版本号接口：只返回一个数字，前端轮询先问这个，没变就不用再拉全量数据了
app.get('/api/data/version', (req, res) => {
  res.json({ version: _dataVersion });
});

app.get('/api/data', async (req, res) => {
  try {
    const data = await loadData();
    const arrKeys = ['sales','payments','phones','suppliers','purchases','earlyPayments','expenses'];
    arrKeys.forEach(k => { if (!Array.isArray(data[k])) data[k] = []; });
    if (!data.nextId) data.nextId = 1001;
    if (!data.company) data.company = {name:'MORODOK',address:'',phone:'',note:''};
    data._dataVersion = _dataVersion;
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

// 删除合同
app.delete('/api/sale/:id', async (req, res) => {
  try {
    await deleteSale(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 删除还款记录
app.delete('/api/payment/:id', async (req, res) => {
  try {
    await deletePayment(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 删除提前还款记录
app.delete('/api/earlyPayment/:id', async (req, res) => {
  try {
    await deleteEarlyPayment(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 清空合同/还款/提前还款数据
app.post('/api/clear', async (req, res) => {
  try {
    const { error: e1 } = await supabase.from('appdata').delete().like('key', 'sale_%');
    if (e1) throw e1;
    const { error: e2 } = await supabase.from('appdata').delete().like('key', 'pay_%');
    if (e2) throw e2;
    const { error: e3 } = await supabase.from('appdata').delete().like('key', 'ep_%');
    if (e3) throw e3;
    _dataVersion = Date.now();
    console.log('✅ 数据已清空');
    res.json({ ok: true, message: '清空成功' });
  } catch (e) {
    console.error('清空失败:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/:collection', async (req, res) => {
  try {
    const { collection } = req.params;
    const allowed = ['phones','suppliers','purchases','company','nextId','expenses','stores'];
    if (!allowed.includes(collection)) return res.status(400).json({ ok: false, error: '不允许的集合' });
    const { error } = await supabase
      .from('appdata')
      .upsert([{ key: collection, value: req.body.value }], { onConflict: 'key' });
    if (error) throw error;
    _dataVersion = Date.now();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/test', async (req, res) => {
  try {
    const { data, error } = await supabase.from('appdata').select('key').limit(1);
    if (error) return res.json({ ok: false, error: error.message });
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

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   📱 MORODOK 手机分期管理系统 — 云端版        ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║   访问地址：http://localhost:${PORT}              ║`);
  console.log('║   数据存储：Supabase 分块存储（每条单独一行）  ║');
  console.log('╚══════════════════════════════════════════════╝\n');
});
