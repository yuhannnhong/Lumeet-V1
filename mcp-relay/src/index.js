// 視訊通話 MCP 橋接：App 把使用者說的話放進來，AI 透過 MCP 取走並回覆
import WEB from './web-assets.js';
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_AI_WAIT = 50;
const MAX_APP_WAIT = 25;
const KEEP = 100;
const MAX_IMAGE_CHARS = 600_000; // base64 JPEG 約 450KB

const INSTRUCTIONS = `這是視訊通話橋接。對方在手機 App 上跟你視訊，你回覆的文字會用對方設定的聲音和角色畫面說出來。
通話流程：
1. 反覆呼叫 call_wait_message 等對方說話。
2. 收到對方的話，用 call_reply 回覆：口語、1 到 3 句短句，不要列點、表情符號或括號動作。想做的表情動作寫在 action（例如「微笑看著鏡頭」）。
3. 回覆完立刻再呼叫 call_wait_message。
4. 收到「通話結束」就停止等待。
結果是「暫時沒說話」時，直接再呼叫一次 call_wait_message。
對方開著鏡頭時，訊息會附一張對方說話當下的自拍畫面。只是一瞬間的截圖，可能剛好拍到眨眼或怪動作，自然帶過就好，不要過度解讀，也不要報出看到的數值。`;

const TOOLS = [
  {
    name: 'call_wait_message',
    description: '等待視訊通話中對方說的話（最多等 50 秒）。回傳對方說的內容或通話開始／結束事件；對方開著鏡頭時會附上對方說話當下的畫面。',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_seconds: { type: 'integer', minimum: 1, maximum: MAX_AI_WAIT, description: '最多等幾秒，預設 45' },
      },
    },
  },
  {
    name: 'call_reply',
    description: '在視訊通話中說話。text 會轉成語音並讓角色對嘴說出。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要說的話，口語短句' },
        action: { type: 'string', description: '表情或動作描述（選填），例如「微笑看著鏡頭」' },
      },
      required: ['text'],
    },
  },
  {
    name: 'call_remember_frame',
    description: '把對方最近一次說話時的鏡頭畫面存成長期記憶（需要橋接器有綁定 R2）。只在值得記住的片刻使用，平常的畫面 7 天後會自動忘記。',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: '為什麼想記住這一刻（選填）' },
      },
    },
  },
  {
    name: 'call_status',
    description: '查看視訊通話狀態：App 是否在線、是否通話中、有幾則未讀。',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ─── Durable Object：保存訊息佇列與等待者 ───────────────────

// 台灣時間的日期與時間，用來當 R2 檔名
function stamp(ms) {
  const d = new Date(ms + 8 * 3600_000).toISOString();
  return { day: d.slice(0, 10), time: d.slice(11, 19).replace(/:/g, '') };
}

function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

export class CallRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env || {};
    this.lastFrame = null;
    this.inbox = [];
    this.outbox = [];
    this.seq = 0;
    this.inCall = false;
    this.appSeenAt = 0;
    this.aiWaiters = new Set();
    this.appWaiters = new Set();
  }

  waitFor(set, ms) {
    return new Promise(resolve => {
      const w = {};
      const timer = setTimeout(() => { set.delete(w); resolve(false); }, ms);
      w.wake = () => { clearTimeout(timer); set.delete(w); resolve(true); };
      set.add(w);
    });
  }

  wakeAll(set) {
    for (const w of [...set]) w.wake();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const op = url.pathname.slice(1);
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

    if (op.startsWith('app/')) this.appSeenAt = Date.now();

    switch (op) {
      case 'app/event': {
        const type = ['message', 'call_started', 'call_ended'].includes(body.type) ? body.type : null;
        if (!type) return Response.json({ error: 'type 無效' }, { status: 400 });
        const text = typeof body.text === 'string' ? body.text.slice(0, 4000) : '';
        if (type === 'message' && !text.trim()) return Response.json({ error: 'text 不可空白' }, { status: 400 });
        if (type === 'call_started') { this.inCall = true; this.inbox = []; }
        if (type === 'call_ended') this.inCall = false;
        const image = type === 'message' && typeof body.image === 'string'
          && body.image.length <= MAX_IMAGE_CHARS && /^[A-Za-z0-9+/=]+$/.test(body.image) ? body.image : null;
        const at = Date.now();
        // 有綁 R2 就把畫面放進視覺快取（vision-cache/，bucket 生命週期規則 7 天後自動刪）
        if (image && this.env.VISION) {
          const { day, time } = stamp(at);
          const key = `vision-cache/${day}/${time}-${at % 1000}.jpg`;
          try {
            await this.env.VISION.put(key, b64ToBytes(image), {
              httpMetadata: { contentType: 'image/jpeg' },
              customMetadata: { said: encodeURIComponent(text.slice(0, 500)) },
            });
            this.lastFrame = { key, text, at };
          } catch {}
        }
        this.inbox.push({ type, text, image, at });
        if (this.inbox.length > KEEP) this.inbox = this.inbox.slice(-KEEP);
        this.wakeAll(this.aiWaiters);
        return Response.json({ ok: true, last_seq: this.seq });
      }

      case 'app/replies': {
        const after = Number(url.searchParams.get('after')) || 0;
        const wait = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), MAX_APP_WAIT);
        const pick = () => this.outbox.filter(r => r.seq > after);
        if (!pick().length && wait > 0) await this.waitFor(this.appWaiters, wait * 1000);
        return Response.json({ replies: pick(), last_seq: this.seq });
      }

      case 'ai/wait': {
        const sec = Math.min(Math.max(Number(body.timeout_seconds) || 45, 1), MAX_AI_WAIT);
        if (!this.inbox.length) await this.waitFor(this.aiWaiters, sec * 1000);
        const events = this.inbox.splice(0);
        return Response.json({ events, in_call: this.inCall });
      }

      case 'ai/reply': {
        const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : '';
        if (!text) return Response.json({ error: 'text 不可空白' }, { status: 400 });
        const action = typeof body.action === 'string' ? body.action.slice(0, 200) : '';
        this.seq += 1;
        this.outbox.push({ seq: this.seq, text, action, at: Date.now() });
        if (this.outbox.length > KEEP) this.outbox = this.outbox.slice(-KEEP);
        this.wakeAll(this.appWaiters);
        return Response.json({ ok: true, in_call: this.inCall });
      }

      case 'ai/remember': {
        if (!this.env.VISION) return Response.json({ error: '橋接器沒有綁定 R2，無法存畫面' }, { status: 400 });
        if (!this.lastFrame) return Response.json({ error: '還沒有可以存的畫面' }, { status: 400 });
        const obj = await this.env.VISION.get(this.lastFrame.key);
        if (!obj) return Response.json({ error: '畫面已經從快取消失了' }, { status: 404 });
        const { day, time } = stamp(this.lastFrame.at);
        const base = `memories/${day}/${time}`;
        const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : '';
        await this.env.VISION.put(`${base}.jpg`, await obj.arrayBuffer(), { httpMetadata: { contentType: 'image/jpeg' } });
        await this.env.VISION.put(`${base}.md`, `對方說：${this.lastFrame.text}\n\n${note}\n`, {
          httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
        });
        return Response.json({ ok: true, key: `${base}.jpg` });
      }

      // 角色圖片：App 上傳後由這裡保管，Vivix 用公開網址來拿（網址帶隨機代碼，猜不到）
      case 'app/portrait': {
        const image = typeof body.image === 'string' && body.image.length <= 2_000_000
          && /^[A-Za-z0-9+/=]+$/.test(body.image) ? body.image : null;
        if (!image) return Response.json({ error: '圖片無效或太大' }, { status: 400 });
        const token = crypto.randomUUID().replace(/-/g, '');
        await this.state.storage.put('portrait', { token, image });
        return Response.json({ ok: true, token });
      }

      case 'portrait': {
        const saved = await this.state.storage.get('portrait');
        if (!saved || saved.token !== url.searchParams.get('token')) {
          return new Response('not found', { status: 404 });
        }
        return new Response(b64ToBytes(saved.image), {
          headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' },
        });
      }

      case 'ai/status':
        return Response.json({
          app_online: Date.now() - this.appSeenAt < 60_000,
          in_call: this.inCall,
          pending_messages: this.inbox.length,
        });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }
}

// ─── MCP ────────────────────────────────────────────────

function room(env) {
  return env.ROOM.get(env.ROOM.idFromName('main'));
}

async function roomCall(env, op, body) {
  const res = await room(env).fetch(`https://room/${op}`, {
    method: 'POST',
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function textContent(text) {
  return [{ type: 'text', text }];
}

// 文字合併成一段；只附最後一張畫面，避免一次塞太多圖
function describeEvents({ events, in_call }) {
  if (!events.length) {
    return textContent(in_call
      ? '（對方暫時沒說話。請再呼叫 call_wait_message 繼續等。）'
      : '（目前沒有進行中的通話。可以再呼叫 call_wait_message 等對方打來。）');
  }
  const lastImage = events.filter(e => e.image).pop();
  const text = events.map(e => {
    if (e.type === 'call_started') return '［通話開始］';
    if (e.type === 'call_ended') return '［通話結束］';
    return `對方說：${e.text}${e === lastImage ? '（附上對方說話當下的鏡頭畫面）' : ''}`;
  }).join('\n');
  const content = textContent(text);
  if (lastImage) content.push({ type: 'image', data: lastImage.image, mimeType: 'image/jpeg' });
  return content;
}

async function callTool(name, args, env) {
  if (name === 'call_wait_message') return describeEvents(await roomCall(env, 'ai/wait', args));
  if (name === 'call_reply') {
    const r = await roomCall(env, 'ai/reply', args);
    return textContent(r.in_call ? '已送出，對方會聽到。' : '已送出，但目前不在通話中，對方可能聽不到。');
  }
  if (name === 'call_remember_frame') {
    const r = await roomCall(env, 'ai/remember', args);
    return textContent(`記住了：${r.key}`);
  }
  if (name === 'call_status') return textContent(JSON.stringify(await roomCall(env, 'ai/status')));
  throw new Error(`未知工具: ${name}`);
}

async function handleRpc(msg, env) {
  const { id, method, params } = msg;
  const ok = result => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        serverInfo: { name: 'ai-video-call-relay', version: '0.2.0' },
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call':
      try {
        return ok({ content: await callTool(params?.name, params?.arguments || {}, env) });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: `錯誤：${e.message}` }], isError: true });
      }
    default:
      return err(-32601, `Method not found: ${method}`);
  }
}

async function handleMcp(request, env) {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 });
  }
  const batch = Array.isArray(body);
  const requests = (batch ? body : [body]).filter(m => m && m.method && 'id' in m);
  if (!requests.length) return new Response(null, { status: 202 });
  const results = await Promise.all(requests.map(m => handleRpc(m, env)));
  return Response.json(batch ? results : results[0]);
}

// ─── 入口 ───────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Relay-Secret, Platform',
  'Access-Control-Expose-Headers': 'X-Trace-Id',
};

function withCors(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

// 簡單的每 IP 速率限制（滑動視窗），避免有人灌爆後端 API 配額或造成 DoS
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
const rateLimitHits = new Map();

function isRateLimited(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  const hits = (rateLimitHits.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  rateLimitHits.set(ip, hits);
  if (rateLimitHits.size > 10_000) rateLimitHits.clear(); // 避免記憶體無限增長
  return hits.length > RATE_LIMIT_MAX;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (isRateLimited(request)) {
      return withCors(Response.json({ error: 'Too Many Requests' }, { status: 429 }));
    }

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // 網頁版頁面（不含任何密碼，Key 都存在使用者自己的瀏覽器）
    if (request.method === 'GET') {
      const file = url.pathname === '/' ? '/index.html' : url.pathname;
      if (WEB[file]) {
        if (file.endsWith('.png')) {
          const bytes = Uint8Array.from(atob(WEB[file].slice('base64:'.length)), c => c.charCodeAt(0));
          return new Response(bytes, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
        }
        const type = file.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : file.endsWith('.webmanifest')
            ? 'application/manifest+json; charset=utf-8'
            : file.endsWith('.css')
              ? 'text/css; charset=utf-8'
              : 'text/javascript; charset=utf-8';
        return new Response(WEB[file], { headers: { 'Content-Type': type, 'Cache-Control': 'no-cache' } });
      }
    }

    // 角色圖片公開網址（Vivix 抓圖不能帶密碼，所以不驗證；靠隨機代碼保護）
    if (request.method === 'GET' && parts[0] === 'portrait' && parts[1]) {
      const token = parts[1].replace(/\.jpg$/, '');
      return room(env).fetch(`https://room/portrait?token=${encodeURIComponent(token)}`);
    }

    // 網頁版用：Vivix 不允許網頁直接呼叫，由這裡轉送。Authorization 是 Vivix Key，所以橋接密碼放 X-Relay-Secret
    if (parts[0] === 'vivix') {
      const relaySecret = request.headers.get('X-Relay-Secret') || '';
      if (!env.RELAY_SECRET || !relaySecret || !(await safeEqual(relaySecret, env.RELAY_SECRET))) {
        return withCors(Response.json({ error: 'Unauthorized' }, { status: 401 }));
      }
      const rest = parts.slice(1).join('/');
      if (!rest.startsWith('v1/realtime-avatar/')) return withCors(Response.json({ error: 'not found' }, { status: 404 }));
      const res = await fetch(`https://api.vivix.ai/${rest}${url.search}`, {
        method: request.method,
        headers: {
          'Authorization': request.headers.get('Authorization') || '',
          'Content-Type': request.headers.get('Content-Type') || 'application/json',
        },
        body: request.method === 'POST' ? request.body : undefined,
      });
      return withCors(res);
    }

    // 網頁版用：MOSS 語音合成也不允許網頁直接呼叫，同樣由這裡轉送
    if (parts[0] === 'moss' || parts[0] === 'moss-audio') {
      const relaySecret = request.headers.get('X-Relay-Secret') || '';
      if (!env.RELAY_SECRET || !relaySecret || !(await safeEqual(relaySecret, env.RELAY_SECRET))) {
        return withCors(Response.json({ error: 'Unauthorized' }, { status: 401 }));
      }
      if (parts[0] === 'moss') {
        if (parts.slice(1).join('/') !== 'v1/audio/speech' || request.method !== 'POST') {
          return withCors(Response.json({ error: 'not found' }, { status: 404 }));
        }
        const res = await fetch('https://api.mosi.cn/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Authorization': request.headers.get('Authorization') || '',
            'Content-Type': 'application/json',
            'Platform': 'moss-platform',
          },
          body: request.body,
        });
        return withCors(res);
      }
      // 下載 MOSS 產生的音檔（只接受 https 網址）
      const target = url.searchParams.get('u') || '';
      if (!/^https:\/\//.test(target)) return withCors(Response.json({ error: 'bad url' }, { status: 400 }));
      const res = await fetch(target);
      return withCors(new Response(res.body, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') || 'audio/mpeg' } }));
    }

    // claude.ai 自訂連接器無法帶 header，所以也接受 /mcp/<secret>
    let secret = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (parts[0] === 'mcp' && parts[1]) secret = parts[1];

    if (!env.RELAY_SECRET || !secret || !(await safeEqual(secret, env.RELAY_SECRET))) {
      return withCors(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    }

    if (parts[0] === 'mcp') return handleMcp(request, env);

    if (parts[0] === 'app' && parts[1]) {
      const res = await room(env).fetch(`https://room/app/${parts[1]}${url.search}`, {
        method: request.method,
        body: request.method === 'POST' ? request.body : undefined,
      });
      if (parts[1] === 'portrait' && res.ok) {
        const { token } = await res.json();
        return withCors(Response.json({ ok: true, url: `${url.origin}/portrait/${token}.jpg` }));
      }
      return withCors(res);
    }

    return withCors(Response.json({ error: 'not found' }, { status: 404 }));
  },
};
