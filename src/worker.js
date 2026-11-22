import { KvStore } from './store.js';
import { Tracker } from './tracker.js';

const INTERVAL = Number(__BT_INTERVAL__ || 1800);
const MIN_INTERVAL = Number(__BT_MIN_INTERVAL__ || 900);
const TRACKER_ID = __BT_TRACKER_ID__ || 'bt-tracker';

function makeStore(torrentsNs, trackersNs, alertsNs) {
  return new KvStore({ torrentsNamespace: torrentsNs, trackersNamespace: trackersNs, alertsNamespace: alertsNs });
}

// Inline dashboard HTML for Workers deployment
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BT Tracker 管理面板</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans SC', sans-serif; background: #f5f7fa; color: #1f2937; line-height: 1.5; }
  .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #e5e7eb; }
  .logo { font-size: 20px; font-weight: 700; color: #2563eb; letter-spacing: -0.5px; }
  .tagline { color: #6b7280; font-size: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
  .card h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin-bottom: 10px; }
  .big { font-size: 34px; font-weight: 700; color: #111827; }
  .muted { color: #6b7280; font-size: 14px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
  .badge-ok { background: #dcfce7; color: #166534; }
  .badge-warn { background: #fef3c7; color: #92400e; }
  .badge-bad { background: #fee2e2; color: #991b1b; }
  .section { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
  .section-title { font-size: 16px; font-weight: 700; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 10px 8px; text-align: left; border-bottom: 1px solid #f3f4f6; }
  th { font-weight: 600; color: #374151; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
  tr:hover { background: #f9fafb; }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border: 1px solid #e5e7eb; background: #fff; color: #111827; border-radius: 8px; font-size: 13px; cursor: pointer; transition: all 0.15s; }
  .btn:hover { border-color: #2563eb; color: #2563eb; background: #f0f7ff; }
  .btn-primary { background: #2563eb; color: #fff; border-color: #2563eb; }
  .btn-primary:hover { background: #1d4ed8; }
  .btn-danger { background: #fee2e2; color: #991b1b; border-color: #fecaca; }
  .btn-danger:hover { background: #fecaca; color: #991b1b; }
  .btn-sm { padding: 4px 10px; font-size: 12px; }
  .form-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 10px; align-items: end; margin-bottom: 12px; }
  input, select { padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 13px; width: 100%; background: #fff; }
  input:focus, select:focus { outline: 2px solid #2563eb; border-color: #2563eb; }
  label { font-size: 12px; color: #6b7280; display: block; margin-bottom: 4px; }
  .switch { position: relative; display: inline-block; width: 44px; height: 24px; }
  .switch input { opacity: 0; width: 0; height: 0; position: absolute; }
  .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background: #ccc; transition: .2s; border-radius: 24px; }
  .slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background: #fff; transition: .2s; border-radius: 50%; }
  input:checked + .slider { background: #2563eb; }
  input:checked + .slider:before { transform: translateX(20px); }
  .empty { color: #9ca3af; font-size: 14px; text-align: center; padding: 30px; }
  .status-good { color: #166534; }
  .status-bad { color: #991b1b; }
  .hash { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #4b5563; word-break: break-all; max-width: 160px; }
  .alert-row { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid #f3f4f6; }
  .alert-row:last-child { border-bottom: none; }
  .toast { position: fixed; bottom: 24px; right: 24px; background: #111827; color: #fff; padding: 10px 16px; border-radius: 8px; font-size: 13px; display: none; z-index: 50; }
  .toast.show { display: block; }
</style>
</head>
<body>

<div class="container">
  <header>
    <div class="logo">🌐 BT Tracker</div>
    <div class="tagline">BitTorrent Tracker 管理面板 &bull; 外部 Tracker 联邦 &bull; 用量提醒</div>
  </header>

  <div class="grid">
    <div class="card">
      <h3>种子总数</h3>
      <div class="big" id="statTorrents">-</div>
      <div class="muted">活跃 / 归档</div>
    </div>
    <div class="card">
      <h3>Peer 总数</h3>
      <div class="big" id="statPeers">-</div>
      <div class="muted">种子 + 下载者</div>
    </div>
    <div class="card">
      <h3>上报次数</h3>
      <div class="big" id="statAnnounces">-</div>
      <div class="muted">累计 announce</div>
    </div>
    <div class="card">
      <h3>抓取次数</h3>
      <div class="big" id="statScrapes">-</div>
      <div class="muted">累计 scrape</div>
    </div>
    <div class="card">
      <h3>外部 Tracker</h3>
      <div class="big" id="statTrackers">-</div>
      <div class="muted">已启用 / 已禁用</div>
    </div>
    <div class="card">
      <h3>运行时间</h3>
      <div class="big" id="statUptime">-</div>
      <div class="muted">自启动以来</div>
    </div>
  </div>

  <section class="section">
    <div class="section-title">🔗 外部 Tracker 管理</div>
    <div class="form-row" style="margin-bottom:16px;">
      <input type="text" id="trackerUrl" placeholder="http://tracker.example.com:6969/announce">
      <input type="text" id="trackerNote" placeholder="备注（可选）">
      <button class="btn btn-primary" onclick="addTracker()">添加</button>
    </div>
    <div id="trackerList" class="loading">加载中...</div>
  </section>

  <section class="section">
    <div class="section-title">🔔 用量提醒 (Alerts)</div>
    <p class="muted" style="margin-bottom:12px;">当指标超过阈值时触发通知（Webhook 或日志）。</p>
    <div class="form-row" style="margin-bottom:16px;">
      <input type="text" id="alertId" placeholder="提醒 ID（如 peers-high）">
      <select id="alertMetric">
        <option value="peers">Peer 数量</option>
        <option value="torrents">种子数量</option>
        <option value="announces">上报次数</option>
        <option value="scrapes">抓取次数</option>
      </select>
      <input type="number" id="alertThreshold" placeholder="阈值">
      <select id="alertComparison">
        <option value="gt">大于</option>
        <option value="gte">大于等于</option>
        <option value="lt">小于</option>
        <option value="lte">小于等于</option>
        <option value="eq">等于</option>
      </select>
      <input type="text" id="alertWebhook" placeholder="Webhook URL（可选）">
      <button class="btn btn-primary" onclick="addAlert()">添加提醒</button>
    </div>
    <div id="alertList" class="loading">加载中...</div>
  </section>

  <section class="section">
    <div class="section-title" style="justify-content:space-between;">
      <span>📦 种子列表</span>
      <button class="btn btn-sm" onclick="loadTorrents()">刷新</button>
    </div>
    <div id="torrentList" class="loading">加载中...</div>
  </section>

  <div id="toast" class="toast"></div>
</div>

<script>
const BASE = '';
function toast(msg, ok = true) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show';
  setTimeout(() => t.className = 'toast', 2500);
}
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json', ...opts.headers }, ...opts });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
async function loadStats() {
  try {
    const s = await api('/stats');
    document.getElementById('statTorrents').textContent = s.torrents ?? 0;
    document.getElementById('statPeers').textContent = s.peers ?? 0;
    document.getElementById('statAnnounces').textContent = s.stats?.announces ?? 0;
    document.getElementById('statScrapes').textContent = s.stats?.scrapes ?? 0;
    document.getElementById('statTrackers').textContent = s.trackers ?? 0;
    const ms = s.uptime ?? 0;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    document.getElementById('statUptime').textContent = h + 'h ' + m + 'm';
  } catch (e) { console.error(e); }
}
async function loadTrackers() {
  try {
    const r = await api('/admin/trackers');
    const el = document.getElementById('trackerList');
    const trs = r.trackers || [];
    if (trs.length === 0) { el.innerHTML = '<div class="empty">暂无外部 tracker，添加一个以上联邦同步 peer。</div>'; return; }
    let html = '<table><thead><tr><th>URL</th><th>备注</th><th>状态</th><th>操作</th></tr></thead><tbody>';
    for (const tr of trs) {
      const enabledCls = tr.enabled ? 'badge-ok' : 'badge-bad';
      const enabledTxt = tr.enabled ? '启用' : '禁用';
      const urlDisplay = tr.url.length > 60 ? tr.url.slice(0, 57) + '...' : tr.url;
      html += `<tr>
        <td><span class="hash" title="${tr.url}">${urlDisplay}</span></td>
        <td>${tr.note || '-'}</td>
        <td><span class="badge ${enabledCls}">${enabledTxt}</span></td>
        <td>
          <button class="btn btn-sm" onclick="toggleTracker('${escapeHtml(tr.url)}', ${!tr.enabled})">${tr.enabled ? '禁用' : '启用'}</button>
          <button class="btn btn-sm btn-danger" onclick="deleteTracker('${escapeHtml(tr.url)}')">删除</button>
        </td>
      </tr>`;
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  } catch (e) {
    document.getElementById('trackerList').innerHTML = '<div class="empty status-bad">加载失败: ' + e.message + '</div>';
  }
}
async function addTracker() {
  const url = document.getElementById('trackerUrl').value.trim();
  const note = document.getElementById('trackerNote').value.trim();
  if (!url) { toast('请输入 tracker URL', false); return; }
  try {
    await api('/admin/trackers', { method: 'POST', body: JSON.stringify({ url, enabled: true, note }) });
    document.getElementById('trackerUrl').value = '';
    document.getElementById('trackerNote').value = '';
    loadTrackers();
    loadStats();
    toast('已添加外部 tracker');
  } catch (e) { toast('添加失败: ' + e.message, false); }
}
async function toggleTracker(url, enabled) {
  try {
    await api('/admin/trackers/' + encodeURIComponent(url), { method: 'PATCH', body: JSON.stringify({ enabled }) });
    loadTrackers();
    loadStats();
  } catch (e) { toast('操作失败: ' + e.message, false); }
}
async function deleteTracker(url) {
  if (!confirm('确定删除该外部 tracker？')) return;
  try {
    await api('/admin/trackers/' + encodeURIComponent(url), { method: 'DELETE' });
    loadTrackers();
    loadStats();
    toast('已删除');
  } catch (e) { toast('删除失败: ' + e.message, false); }
}
async function loadAlerts() {
  try {
    const r = await api('/admin/alerts');
    const el = document.getElementById('alertList');
    const alerts = r.alerts || [];
    if (alerts.length === 0) { el.innerHTML = '<div class="empty">暂无提醒规则，添加一个以上监控用量。</div>'; return; }
    let html = '';
    for (const a of alerts) {
      const enabledCls = a.enabled ? 'badge-ok' : 'badge-bad';
      html += `<div class="alert-row">
        <div style="flex:1;">
          <div style="font-weight:600;">${escapeHtml(a.id)}</div>
          <div class="muted" style="font-size:12px;">${a.metric} ${a.comparison} ${a.threshold} &bull; 冷却 ${Math.round(a.cooldownMs/1000/60)} 分钟 &bull; 最后触发 ${a.lastTriggered ? new Date(a.lastTriggered).toLocaleString() : '从未'}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <label class="switch" style="margin:0;"><input type="checkbox" ${a.enabled ? 'checked' : ''} onchange="toggleAlert('${escapeHtml(a.id)}', ${!a.enabled})"><div class="slider"></div></label>
          <button class="btn btn-sm btn-danger" onclick="deleteAlert('${escapeHtml(a.id)}')">删除</button>
        </div>
      </div>`;
    }
    el.innerHTML = html;
  } catch (e) {
    document.getElementById('alertList').innerHTML = '<div class="empty status-bad">加载失败: ' + e.message + '</div>';
  }
}
async function addAlert() {
  const id = document.getElementById('alertId').value.trim();
  const metric = document.getElementById('alertMetric').value;
  const threshold = document.getElementById('alertThreshold').value.trim();
  const comparison = document.getElementById('alertComparison').value;
  const webhook = document.getElementById('alertWebhook').value.trim();
  if (!id || !threshold) { toast('请填写 ID 和阈值', false); return; }
  try {
    await api('/admin/alerts', { method: 'POST', body: JSON.stringify({ id, metric, threshold, comparison, webhookUrl: webhook }) });
    document.getElementById('alertId').value = '';
    document.getElementById('alertThreshold').value = '';
    document.getElementById('alertWebhook').value = '';
    loadAlerts();
    toast('已添加提醒规则');
  } catch (e) { toast('添加失败: ' + e.message, false); }
}
async function toggleAlert(id, enabled) {
  try {
    await api('/admin/alerts/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ enabled }) });
    loadAlerts();
  } catch (e) { toast('操作失败: ' + e.message, false); }
}
async function deleteAlert(id) {
  if (!confirm('确定删除该提醒规则？')) return;
  try {
    await api('/admin/alerts/' + encodeURIComponent(id), { method: 'DELETE' });
    loadAlerts();
    toast('已删除');
  } catch (e) { toast('删除失败: ' + e.message, false); }
}
async function loadTorrents() {
  try {
    const r = await api('/admin/export');
    const torrents = r.torrents || [];
    const el = document.getElementById('torrentList');
    if (torrents.length === 0) { el.innerHTML = '<div class="empty">暂无种子记录。</div>'; return; }
    let html = '<table><thead><tr><th>Info Hash</th><th>Peer 数</th><th>已完成</th><th>创建时间</th><th>更新时间</th></tr></thead><tbody>';
    for (const t of torrents) {
      const peers = t.peers ? Object.keys(t.peers).length : 0;
      const created = t.createdAt ? new Date(t.createdAt).toLocaleString() : '-';
      const updated = t.updatedAt ? new Date(t.updatedAt).toLocaleString() : '-';
      html += `<tr>
        <td><span class="hash" title="${t.infoHash}">${t.infoHash}</span></td>
        <td>${peers}</td>
        <td>${t.completed || 0}</td>
        <td>${created}</td>
        <td>${updated}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  } catch (e) {
    document.getElementById('torrentList').innerHTML = '<div class="empty status-bad">加载失败: ' + e.message + '</div>';
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]));
}
document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  loadTrackers();
  loadAlerts();
  loadTorrents();
  setInterval(loadStats, 15000);
  setInterval(loadTrackers, 30000);
  setInterval(loadAlerts, 30000);
});
</script>

</body>
</html>
`;

export default {
  async fetch(request, env, ctx) {
    const store = makeStore(env.BT_TORRENTS, env.BT_TRACKERS, env.BT_ALERTS);
    const tracker = new Tracker({
      store,
      interval: INTERVAL,
      minInterval: MIN_INTERVAL,
      trackerId: TRACKER_ID,
      /* External tracker fetcher for Cloudflare Workers */
      externalFetch: async (url, params) => {
        try {
          const u = new URL(url);
          for (const [k, v] of Object.entries(params)) {
            if (v === undefined) continue;
            u.searchParams.set(k, String(v));
          }
          const res = await fetch(u.toString(), {
            method: 'GET',
            headers: { 'User-Agent': 'bt-tracker/1.0' },
          });
          if (!res.ok) return { ok: false };
          const ab = await res.arrayBuffer();
          const body = new Uint8Array(ab);
          const { decodeSync } = await import('./bencode.js');
          const decoded = decodeSync(body);
          if (!decoded || typeof decoded !== 'object') return { ok: false };

          const peers = [];
          const p = decoded.peers;
          if (Array.isArray(p)) {
            for (const item of p) {
              if (item && item.ip && item.port !== undefined) {
                peers.push({ ip: item.ip, port: Number(item.port), peerId: item.peer_id || '' });
              }
            }
          } else if (p instanceof Uint8Array) {
            for (let i = 0; i + 5 < p.length; i += 6) {
              const ip = [p[i], p[i+1], p[i+2], p[i+3]].join('.');
              const port = (p[i+4] << 8) | p[i+5];
              peers.push({ ip, port, peerId: 'ext' });
            }
          }
          return {
            ok: true,
            peers,
            complete: decoded.complete,
            incomplete: decoded.incomplete
          };
        } catch (e) {
          return { ok: false };
        }
      }
    });

    const url = new URL(request.url);
    const path = url.pathname;

    // Dashboard HTML
    if (path === '/dashboard' || path === '/dashboard/') {
      return new Response(DASHBOARD_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // tracker endpoints
    if (path === '/announce' || path === '/scrape' || path === '/stats') {
      return tracker.handleRequest(request);
    }

    // admin endpoints
    if (path.startsWith('/admin/')) {
      return adminHandler(request, tracker, url);
    }

    return new Response('not found', { status: 404 });
  }
};

async function adminHandler(request, tracker, url) {
  const path = url.pathname;
  const method = request.method;
  const query = {};
  for (const [k, v] of url.searchParams) query[k] = v;

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });

  let body = null;
  if (method === 'POST' || method === 'PATCH') {
    try { body = await request.json(); } catch { body = null; }
  }

  try {
    if (path === '/admin/trackers') {
      if (method === 'GET') return json(await tracker.listTrackers());
      if (method === 'POST') return json(await tracker.addTracker(body && body.url, body && body.enabled !== false, body && body.note));
      return json({ ok: false, error: 'method not allowed' }, 405);
    }
    const m = path.match(/^\/admin\/trackers\/(.+)$/);
    if (m) {
      const targetUrl = decodeURIComponent(m[1]);
      if (method === 'DELETE') return json(await tracker.removeTracker(targetUrl));
      if (method === 'PATCH') return json(await tracker.setTracker(targetUrl, { enabled: body && body.enabled, note: body && body.note }));
      return json({ ok: false, error: 'method not allowed' }, 405);
    }
    // admin alerts API
    if (path === '/admin/alerts') {
      if (method === 'GET') return json(await tracker.listAlerts());
      if (method === 'POST') return json(await tracker.addAlert(body));
      return json({ ok: false, error: 'method not allowed' }, 405);
    }
    const m2 = path.match(/^\/admin\/alerts\/(.+)$/);
    if (m2) {
      const id = decodeURIComponent(m2[1]);
      if (method === 'DELETE') return json(await tracker.deleteAlert(id));
      if (method === 'PATCH') return json(await tracker.updateAlert(id, body));
      return json({ ok: false, error: 'method not allowed' }, 405);
    }
    if (path === '/admin/export') {
      const r = await tracker.exportTorrents();
      return json(r.data);
    }
    if (path === '/admin/import') {
      if (method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
      const merge = query.merge !== 'false';
      const r = await tracker.importTorrents(body, { merge });
      return json(r);
    }
    return json({ ok: false, error: 'not found' }, 404);
  } catch (e) {
    console.error('[tracker] admin error', e);
    return json({ ok: false, error: 'internal error' }, 500);
  }
}
