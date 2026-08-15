// 有声书：GET /voicedrop/books/audiobook/<slug>/<章stem>  （voicedrop.cn 走 /books/audiobook/...）
//
// 播放策略（一次合成、永久缓存）：
//   1. R2 有 audiobook/<slug>/<stem>.mp3 → 直接回源，带 Range 支持（可拖进度条）。
//   2. 没有 → 用火山豆包 seed-tts-2.0 单向流式接口逐段合成，音频块边到边流给
//      客户端（渐进式 mp3，<audio> 点了就能播），同时全量攒在内存；合成完
//      waitUntil 写回 R2。客户端中途断开也会把整章合成完存好，只花一次钱。
//
// 朗读脚本两种来源：
//   a. R2 audiobook/<slug>/<stem>.script.txt —— 人工编排的多音色脚本
//      （@voice 别名 音色ID / @别名 切换 / [表演指令] 或【表演指令】），最优。
//   b. 没有脚本 → 从章节 HTML 确定性自动编排：正文/标题=旁白（渊博小叔），
//      div.plain「大白话」框=插话（反卷青年），blockquote=引用（译制片男）。
//
// 火山的三个坑（都在本文件里规避，来龙去脉见 ~/code/volcano-tts/tts.py）：
//   - context_texts/section_id 必须嵌在 additions（JSON 字符串）里，顶层被静默忽略；
//   - context_texts 多条只有第一条生效 → 每段只发一条；
//   - 只能用 2.0 音色（_uranus_bigtts 后缀），其他报 resource mismatch。
//
// 凭据：Pages secrets VOLC_TTS_APPID / VOLC_TTS_ACCESS_TOKEN。

const PUBLISHER = 'users/anon-ae209ac53499d51d513425503bd134b0/books/';
const CACHE_PREFIX = 'audiobook/';
const TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

const NARRATOR = 'zh_male_yuanboxiaoshu_uranus_bigtts';   // 旁白·渊博小叔
const CASUAL = 'zh_female_shuangkuaisisi_uranus_bigtts';  // 大白话·爽快思思（女声，与男声旁白区分）
const QUOTE = 'zh_male_yizhipiannan_uranus_bigtts';       // 引用·译制片男
const GLOBAL_INSTR = {
  [NARRATOR]: '这是一本有声书，请像一位知识渊博的朋友在给你讲故事，自然口语化，娓娓道来，不要播音腔',
  [CASUAL]: '请用轻松的大白话语气插话，像朋友凑过来给你打比方划重点',
  [QUOTE]: '请用郑重的引述语气朗读这段引文',
};

export async function onRequest({ request, env, params, waitUntil }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405 });
  }
  const seg = Array.isArray(params.path) ? params.path : (params.path ? [params.path] : []);
  if (seg.length !== 2) return json404('usage: /audiobook/<book>/<chapter>');
  const book = decodeURIComponent(seg[0]);
  const stem = decodeURIComponent(seg[1]).replace(/\.mp3$/, '');
  if (book.includes('..') || stem.includes('..') || stem.includes('/')) return json404('bad path');

  const mp3Key = `${CACHE_PREFIX}${book}/${stem}.mp3`;

  // ── 已缓存：直接回源（带 Range）─────────────────────────────
  const head = await env.FILES.head(mp3Key);
  if (head) return serveCached(env, mp3Key, head, request);

  if (request.method === 'HEAD') return new Response(null, { status: 404 });

  // ── 未缓存：取脚本或自动编排，边合成边流 ─────────────────────
  const segments = await loadSegments(env, book, stem);
  if (!segments || !segments.length) return json404('chapter not found');

  const { readable, writable } = new TransformStream();
  waitUntil(synthesizeAll(env, segments, writable.getWriter(), mp3Key));
  return new Response(readable, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',          // 首播不缓存在 CDN，成品以 R2 为准
      'Accept-Ranges': 'none',              // 流式阶段不支持拖动
      'Access-Control-Allow-Origin': '*',
      'X-Audiobook': 'generating',
    },
  });
}

// ---------- 缓存回源（Range 支持，<audio> 拖进度条需要） ----------
async function serveCached(env, key, head, request) {
  const size = head.size;
  const range = parseRange(request.headers.get('Range'), size);
  const obj = await env.FILES.get(key, range ? { range } : undefined);
  if (!obj) return json404('gone');
  const headers = {
    'Content-Type': 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*',
    'X-Audiobook': 'cached',
  };
  if (range) {
    headers['Content-Range'] = `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`;
    headers['Content-Length'] = String(range.length);
    return new Response(request.method === 'HEAD' ? null : obj.body, { status: 206, headers });
  }
  headers['Content-Length'] = String(size);
  return new Response(request.method === 'HEAD' ? null : obj.body, { headers });
}

function parseRange(h, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(h || '');
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) { const n = Math.min(+m[2], size); return { offset: size - n, length: n }; }
  const start = +m[1];
  if (start >= size) return null;
  const end = m[2] ? Math.min(+m[2], size - 1) : size - 1;
  return { offset: start, length: end - start + 1 };
}

// ---------- 朗读材料：脚本优先，否则从章节 HTML 自动编排 ----------
// 返回 [{voice, instr, text}]
async function loadSegments(env, book, stem) {
  const scriptObj = await env.FILES.get(`${CACHE_PREFIX}${book}/${stem}.script.txt`);
  if (scriptObj) return parseScript(await scriptObj.text());
  const pageObj = await env.FILES.get(`${PUBLISHER}${book}/${stem}.html`);
  if (!pageObj) return null;
  return autoOrchestrate(await pageObj.text());
}

// 多音色脚本：@voice 别名 音色ID 定义；@别名 切换；[指令]/【指令】按段生效；# 注释。
function parseScript(text) {
  const voices = {};
  let current = NARRATOR;
  const out = [];
  let buf = [];
  const flush = () => {
    const joined = buf.join('\n').trim();
    buf = [];
    if (joined) splitAnnotated(joined).forEach(([instr, t]) => out.push({ voice: current, instr, text: t }));
  };
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (s.startsWith('#')) continue;
    if (s.startsWith('@voice ')) {
      const p = s.split(/\s+/);
      if (p.length >= 3) voices[p[1]] = p[2];
      continue;
    }
    if (s.startsWith('@') && !s.includes(' ') && s.length > 1) {
      flush();
      current = voices[s.slice(1)] || s.slice(1);
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

// 把带【】/[ ]标注的文本切成 [instr|null, text] 序列
function splitAnnotated(text) {
  const re = /【([^】]*)】|\[([^\][]{1,60})\]/g;
  const parts = [];
  let pos = 0, instr = null, m;
  while ((m = re.exec(text))) {
    const chunk = text.slice(pos, m.index).trim();
    if (chunk) parts.push([instr, chunk]);
    instr = (m[1] ?? m[2] ?? '').trim() || null;
    pos = m.index + m[0].length;
  }
  const tail = text.slice(pos).trim();
  if (tail) parts.push([instr, tail]);
  return parts;
}

// 无脚本时的确定性编排：标题→旁白开场；div.plain→插话声；blockquote→引用声；
// h2/h3/p/li→旁白。同声连续小块合并到 ~500 字，减少切段。
function autoOrchestrate(html) {
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const blocks = [];
  const title = text1(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)) || text1(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html));
  if (title) blocks.push({ voice: NARRATOR, text: title.replace(/\s*·\s*/g, '。') + '。' });

  // 先摘出 plain / blockquote，占位防止被当正文重复读
  const specials = [];
  html = html.replace(/<div class="plain">([\s\S]*?)<\/div>|<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (_, plain, quote) => {
      specials.push({ voice: plain != null ? CASUAL : QUOTE, text: strip(plain ?? quote) });
      return `\n@@SPECIAL${specials.length - 1}@@\n`;
    });

  const re = /@@SPECIAL(\d+)@@|<(h2|h3|p|li)[^>]*>([\s\S]*?)<\/\2>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] != null) { const s = specials[+m[1]]; if (s.text) blocks.push(s); continue; }
    const t = strip(m[3]);
    if (t) blocks.push({ voice: NARRATOR, text: t });
  }

  // 合并同声连续块
  const merged = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last && last.voice === b.voice && last.text.length + b.text.length < 500) {
      last.text += '\n' + b.text;
    } else merged.push({ ...b });
  }
  return merged.map((b) => ({ ...b, instr: null }));
}

const text1 = (m) => (m ? strip(m[1]) : '');
function strip(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

// ---------- 逐段合成：边流给客户端，边攒全量，完了写 R2 ----------
async function synthesizeAll(env, segments, writer, mp3Key) {
  const all = [];
  let clientGone = false;
  let ok = true;
  const sectionId = crypto.randomUUID();
  for (const seg of segments) {
    try {
      await synthesizeOne(env, seg, sectionId, async (bytes) => {
        all.push(bytes);
        if (!clientGone) {
          try { await writer.write(bytes); } catch { clientGone = true; }
        }
      });
    } catch (e) {
      ok = false;
      console.log('tts segment failed:', e.message, seg.text.slice(0, 30));
      break; // 失败就停：宁可不缓存，也不缓存残次品
    }
  }
  try { await writer.close(); } catch {}
  if (ok && all.length) {
    const total = all.reduce((n, b) => n + b.length, 0);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const b of all) { buf.set(b, off); off += b.length; }
    await env.FILES.put(mp3Key, buf, { httpMetadata: { contentType: 'audio/mpeg' } });
  }
}

async function synthesizeOne(env, seg, sectionId, onAudio) {
  const instr = seg.instr || GLOBAL_INSTR[seg.voice] || GLOBAL_INSTR[NARRATOR];
  const additions = { section_id: sectionId, context_texts: [instr] }; // 单条：多条只认第一条
  const resp = await fetch(TTS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-App-Id': env.VOLC_TTS_APPID,
      'X-Api-Access-Key': env.VOLC_TTS_ACCESS_TOKEN,
      'X-Api-Resource-Id': 'seed-tts-2.0',
      'X-Api-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify({
      req_params: {
        text: seg.text,
        speaker: seg.voice,
        additions: JSON.stringify(additions),
        audio_params: { format: 'mp3', sample_rate: 24000 },
      },
    }),
  });
  if (!resp.ok) throw new Error(`volcano http ${resp.status}`);

  // chunked 流里是一串首尾相接/换行分隔的 JSON 对象，逐个扫出来
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let got = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let obj;
    while (([obj, buf] = scanJSON(buf)), obj !== undefined) {
      const code = obj.code ?? 0;
      if (code !== 0 && code !== 20000000) throw new Error(`volcano code ${code}: ${obj.message}`);
      if (obj.data) { onAudio && await onAudio(b64ToBytes(obj.data)); got = true; }
    }
  }
  if (!got) throw new Error('no audio in stream');
}

// 从 buf 头部扫一个完整 JSON 对象；返回 [对象|undefined, 剩余]
function scanJSON(buf) {
  let i = 0;
  while (i < buf.length && (buf[i] === ' ' || buf[i] === '\n' || buf[i] === '\r' || buf[i] === '\t')) i++;
  if (i >= buf.length || buf[i] !== '{') return [undefined, buf.slice(i)];
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < buf.length; j++) {
    const c = buf[j];
    if (esc) { esc = false; continue; }
    if (c === '\\') { if (inStr) esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return [JSON.parse(buf.slice(i, j + 1)), buf.slice(j + 1)]; }
        catch { return [undefined, buf.slice(i)]; }
      }
    }
  }
  return [undefined, buf.slice(i)];
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function json404(msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
