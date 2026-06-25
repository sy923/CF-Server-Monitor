import { saveMetricsHistory } from '../database/schema.js';
import { checkServerExists } from '../utils/cache.js';
import { mergeMetricsIntoServer } from '../utils/metrics.js';
import { createErrorResponse, createUnauthorizedResponse, createNotFoundResponse } from '../utils/errors.js';

// 将最新一次上报打包成前端可直接消费的 "当前状态" 对象
// 与 /api/server 和 /api/servers 返回的字段保持一致，便于页面直接合并
function buildPayloadForBroadcast(id, metrics, extra = {}) {
  const payload = {};
  mergeMetricsIntoServer(payload, metrics);
  payload.id = id;
  payload.region = extra.region || '';
  payload.last_updated = metrics.timestamp || Date.now();
  payload.timestamp = payload.last_updated;
  return payload;
}

// 批量推送：10秒窗口内合并向 DO 推送一次，减少请求次数
const BATCH_WINDOW = 10000;
let batchQueue = new Map();
let flushingPromise = null;

// 用于过滤不需要实时更新的字段
const BROADCAST_DELETE_FIELDS = ['id', 'name', 'region', 'arch', 'os', 'cpu_info', 'cpu_cores', 'gpu_info', 'ram_total', 'disk_total', 'expire_date', 'server_group', 'traffic_limit', 'net_rx_monthly', 'net_tx_monthly', 'boot_time', 'timestamp', 'ip_v4', 'ip_v6', 'swap_total'];

async function _flushBatch(env) {
  flushingPromise = null;

  if (batchQueue.size === 0) return;

  // 原子性地取出当前队列，避免并发写入干扰
  const queue = batchQueue;
  batchQueue = new Map();

  const updates = [];
  for (const [serverId, payload] of queue) {
    const filtered = Object.assign({}, payload);
    BROADCAST_DELETE_FIELDS.forEach(field => delete filtered[field]);
    updates.push({ serverId, payload: filtered });
  }

  if (updates.length === 0) return;

  try {
    const id = env.METRICS_BROADCASTER.idFromName('global');
    const stub = env.METRICS_BROADCASTER.get(id);
    await stub.fetch('http://internal/batch-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates })
    });
  } catch (e) {
    console.warn('[broadcast] batch push failed:', e.message || e);
  }
}

function _ensureBatchFlush(env) {
  if (flushingPromise) return flushingPromise;

  flushingPromise = new Promise(resolve => setTimeout(resolve, BATCH_WINDOW))
    .then(() => _flushBatch(env));

  return flushingPromise;
}

export async function handleUpdate(request, env, ctx) {
  try {
    const data = await request.json();
    const { id, secret, metrics } = data;

    if (secret !== env.API_SECRET) {
      return createUnauthorizedResponse('Invalid secret');
    }

    let regionCode = request.cf?.country || request.headers?.get('cf-ipcountry') || '';

    const serverExists = await checkServerExists(env.DB, id);

    if (!serverExists) {
      return createNotFoundResponse('Server not found');
    }

    await saveMetricsHistory(env.DB, id, metrics, regionCode);

    const payload = buildPayloadForBroadcast(id, metrics || {}, { region: regionCode });
    // 加入批量队列，由后台定时任务统一推送到 DO
    batchQueue.set(id, payload);
    ctx.waitUntil(_ensureBatchFlush(env));

    return new Response('OK', { status: 200 });
  } catch (e) {
    return createErrorResponse(e);
  }
}

// 暴露给 index.js 路由使用的 WebSocket 接入函数
export async function handleWebSocketUpgrade(request, env) {
  if (!env || !env.METRICS_BROADCASTER) {
    return new Response(JSON.stringify({ error: 'WebSocket not enabled', code: 503 }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const url = new URL(request.url);
  const qs = url.search || '';
  try {
    const id = env.METRICS_BROADCASTER.idFromName('global');
    const stub = env.METRICS_BROADCASTER.get(id);
    // 使用原始 request 构造新的内部请求，保留 WebSocket 升级语义
    return await stub.fetch(new Request(`http://internal/ws${qs}`, request));
  } catch (e) {
    console.error('[ws] DO upgrade failed:', e);
    return new Response(JSON.stringify({ error: 'WebSocket error', code: 500 }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
