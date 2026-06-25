// Durable Object: 服务器监控指标广播中心
// 负责维护 WebSocket 连接并在收到新指标时向订阅者实时推送
//
// - 连接通过 /api/ws?subscribe=<scope> 建立
//   scope = 'all'        -> 订阅所有服务器更新（首页）
//   scope = <serverId>   -> 只订阅某台服务器的更新（详情页）
//
// - 后端 /update 处理器在成功写入 DB 后，调用 /__do_push/<id>
//   由本 DO 向所有订阅者广播刚收到的指标。
//
// - 心跳：每 25s 向客户端发送 ping，避免中间代理断连。

function parseAllowedOrigins(corsAllowedOrigins) {
  if (!corsAllowedOrigins || corsAllowedOrigins.trim() === '') {
    return [];
  }
  return corsAllowedOrigins
    .split(',')
    .map(o => o.trim())
    .filter(o => o !== '');
}

export class MetricsBroadcaster {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.nextSessionId = 0;
    this.scopeMap = new Map();
    this._lock = false;
    this.batchQueue = new Map();
    this.batchTimer = null;
    this.batchInterval = 5000;
    if (this.state && typeof this.state.blockConcurrencyWhile === 'function') {
      this.state.blockConcurrencyWhile(async () => {});
    }
  }

  // 根据 scope 判断会话是否需要接收某台服务器的更新
  _shouldDeliver(sessionScope, serverId) {
    if (!sessionScope) return false;
    if (sessionScope === 'all') return true;
    return sessionScope === serverId;
  }

  _removeSession(sid, scope) {
    if (this._lock) return;
    this._lock = true;
    try {
      this.sessions.delete(sid);
      this.batchQueue.delete(sid);
      if (scope) {
        const set = this.scopeMap.get(scope);
        if (set) {
          set.delete(sid);
          if (set.size === 0) {
            this.scopeMap.delete(scope);
          }
        }
      }
      if (this.sessions.size === 0) {
        this.scopeMap.clear();
        this.batchQueue.clear();
        if (this.batchTimer) {
          clearTimeout(this.batchTimer);
          this.batchTimer = null;
        }
      }
    } finally {
      this._lock = false;
    }
  }
  

  _flushBatch() {
    this.batchTimer = null;
    if (this.batchQueue.size === 0 || this.sessions.size === 0) {
      this.batchQueue.clear();
      return;
    }

    const queue = this.batchQueue;
    this.batchQueue = new Map();

    for (const [sid, updates] of queue) {
      const session = this.sessions.get(sid);
      if (!session) continue;

      const ws = session.ws;
      if (ws.readyState !== 1) {
        this._removeSession(sid, session.scope);
        continue;
      }

      const message = JSON.stringify({
        type: 'batchUpdate',
        ts: Date.now(),
        updates
      });

      try {
        ws.send(message);
      } catch (e) {
        try { ws.close(); } catch (_) {}
        this._removeSession(sid, session.scope);
      }
    }
  }

  _ensureBatchTimer() {
    if (this.batchTimer) return;
    this.batchTimer = setTimeout(() => this._flushBatch(), this.batchInterval);
  }

  _broadcast(serverId, payload) {
    const hasListeners = this.scopeMap.has('all') || this.scopeMap.has(serverId);
    if (!hasListeners) return;

    const message = JSON.stringify({
      type: 'update',
      serverId,
      ts: Date.now(),
      data: payload
    });

    const allSet = this.scopeMap.get('all');
    const specificSet = this.scopeMap.get(serverId);

    if (specificSet) {
      for (const sid of specificSet) {
        const session = this.sessions.get(sid);
        if (!session) continue;

        const ws = session.ws;
        if (ws.readyState !== 1) {
          this._removeSession(sid, session.scope);
          continue;
        }

        try {
          ws.send(message);
        } catch (e) {
          try { ws.close(); } catch (_) {}
          this._removeSession(sid, session.scope);
        }
      }
    }

    if (allSet) {
      for (const sid of allSet) {
        const session = this.sessions.get(sid);
        if (!session) continue;

        if (session.ws.readyState !== 1) {
          this._removeSession(sid, session.scope);
          continue;
        }

        if (!this.batchQueue.has(sid)) {
          this.batchQueue.set(sid, []);
        }
        this.batchQueue.get(sid).push({
          serverId,
          ts: Date.now(),
          data: payload
        });
      }
    }

    if (this.batchQueue.size > 0 && this.sessions.size > 0) {
      this._ensureBatchTimer();
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // 1) WebSocket 接入
    if (path === '/ws' || path.endsWith('/ws')) {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade request', { status: 426 });
      }
      
      const origin = request.headers.get('Origin');
      const allowedOrigins = parseAllowedOrigins(this.env.CORS_ALLOWED_ORIGINS);
      
      const raw = url.searchParams.get('subscribe') || 'all';
      const scope = raw.trim().toLowerCase();

      // @ts-ignore - Cloudflare Workers 运行时提供 WebSocketPair
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      const sid = ++this.nextSessionId;
      this.sessions.set(sid, { ws: server, scope, createdAt: Date.now() });

      if (!this.scopeMap.has(scope)) {
        this.scopeMap.set(scope, new Set());
      }
      this.scopeMap.get(scope).add(sid);

      const cleanup = () => {
        this._removeSession(sid, scope);
        try { server.close(); } catch (_) {}
      };

      server.addEventListener('close', cleanup);
      server.addEventListener('error', cleanup);
      server.addEventListener('message', (event) => {
        // 简单处理客户端的 ping
        try {
          const msg = JSON.parse(event.data || '{}');
          if (msg && msg.type === 'pong') return;
          if (msg && msg.type === 'ping') {
            if (server.readyState === 1) {
              server.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
            }
          }
        } catch (_) {}
      });

      // 立即发送一条 "hello" 让客户端确认连接成功
      try {
        server.send(JSON.stringify({
          type: 'hello',
          ts: Date.now(),
          subscribed: scope
        }));
      } catch (_) {}

      const responseHeaders = new Headers();
      responseHeaders.set('Access-Control-Allow-Origin', origin);
      responseHeaders.set('Access-Control-Allow-Credentials', 'true');

      return new Response(null, { status: 101, webSocket: client, headers: responseHeaders });
    }

    // 2) 内部广播入口：/update 成功后由 Worker 内部转发
    //    path: /push/<serverId>   body: { metrics } JSON
    if (method === 'POST' && (path.startsWith('/push/') || path.includes('/push/'))) {
      const parts = path.split('/push/');
      const serverId = decodeURIComponent((parts[1] || '').split('/')[0] || '');
      if (!serverId) {
        return new Response(JSON.stringify({ error: 'missing serverId' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      let payload = null;
      try {
        payload = await request.json();
      } catch (_) {
        return new Response(JSON.stringify({ error: 'invalid JSON' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      this._broadcast(serverId, payload);
      return new Response(JSON.stringify({ ok: true, subscribers: this.sessions.size }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 2b) 批量推送入口：批量接收多个服务器更新，减少 DO 请求次数
    //     body: { updates: [{ serverId, payload }, ...] }
    if (method === 'POST' && path === '/batch-push') {
      let body = null;
      try {
        body = await request.json();
      } catch (_) {
        return new Response(JSON.stringify({ error: 'invalid JSON' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const updates = body && body.updates;
      if (!Array.isArray(updates) || updates.length === 0) {
        return new Response(JSON.stringify({ error: 'missing or empty updates array' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      for (const item of updates) {
        if (item.serverId && item.payload) {
          this._broadcast(item.serverId, item.payload);
        }
      }

      return new Response(JSON.stringify({ ok: true, count: updates.length, subscribers: this.sessions.size }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 3) 健康检查
    if (method === 'GET' && (path === '/health' || path.endsWith('/health'))) {
      return new Response(JSON.stringify({ ok: true, subscribers: this.sessions.size }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not found', { status: 404 });
  }
}

export default MetricsBroadcaster;
