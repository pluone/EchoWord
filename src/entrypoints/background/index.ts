export default defineBackground(() => {
// EchoWord — 后台服务：用 chrome.tts 朗读 content script 传来的文字。

const DEFAULT_LANG = 'en-US';
const DEFAULT_OPTIONS = { voiceName: '', volume: 100, rate: 1 };

type SpeakConfig = { voiceName: string; volume: number; rate: number };
type SpeakOptions = {
  lang?: string;
  voiceName?: string;
  volume?: number;
  rate?: number;
  enqueue?: boolean;
  onEvent?: (event: { type: string }) => void;
};
type VoiceInfo = { voiceName: string; lang: string; remote: boolean };

function isEnglishVoice(lang) {
  const l = (lang || '').toLowerCase();
  return l === 'en' || l.startsWith('en-') || l.startsWith('en_');
}

// macOS 内置的「搞怪」声音，不适合英文阅读，从列表中剔除。
const NOVELTY_VOICE_NAMES = new Set([
  'Albert',
  'Bad News',
  'Bahh',
  'Bells',
  'Boing',
  'Bubbles',
  'Cellos',
  'Good News',
  'Jester',
  'Organ',
  'Superstar',
  'Trinoids',
  'Whisper',
  'Wobble',
  'Zarvox',
]);

// macOS 内置的 Eloquence 合成音，带机械音，同样不适合英文阅读，单独成表过滤。
const ELOQUENCE_VOICE_NAMES = new Set([
  'Eddy',
  'Flo',
  'Grandma',
  'Grandpa',
  'Reed',
  'Rocko',
  'Sandy',
  'Shelley',
]);

// 获取所有英文语音（本地在前、远程在后，各自按名称排序）。
function getEnglishVoices() {
  return new Promise<VoiceInfo[]>((resolve) => {
    chrome.tts.getVoices((voices) => {
      const enVoices = (voices || [])
        .filter((v) => isEnglishVoice(v.lang))
        .filter((v) => !NOVELTY_VOICE_NAMES.has(v.voiceName))
        .filter((v) => !ELOQUENCE_VOICE_NAMES.has(v.voiceName))
        .map((v) => ({
          voiceName: v.voiceName,
          lang: v.lang,
          remote: !!v.remote,
        }))
        .sort((a, b) => {
          if (a.remote !== b.remote) return a.remote ? 1 : -1;
          return (a.voiceName || '').localeCompare(b.voiceName || '');
        });
      resolve(enVoices);
    });
  });
}

// 朗读：应用用户配置的语音 / 音量 / 速度。
// voiceNameOverride 存在时优先使用它（如试听某个指定的声音）。
function speakText(text, voiceNameOverride) {
  chrome.storage.local.get(DEFAULT_OPTIONS, (cfg: SpeakConfig) => {
    const options: SpeakOptions = {
      lang: DEFAULT_LANG,
      enqueue: false,
      // chrome.tts 的 volume 上限为 1.0，故把 0–200% 钳制到 0–100%。
      volume: Math.min(Math.max(cfg.volume, 0), 100) / 100,
      rate: cfg.rate,
    };
    const voiceName = voiceNameOverride || cfg.voiceName;
    if (voiceName) options.voiceName = voiceName;
    chrome.tts.speak(text, options);
  });
}

// word_sentence 模式的待触发整句朗读定时器：停止朗读或发起新的朗读时取消，
// 避免上个单词的整句在延迟后仍串场。
let sequenceTimer = null;

function cancelSequence() {
  if (sequenceTimer) {
    clearTimeout(sequenceTimer);
    sequenceTimer = null;
  }
}

// 先朗读单词，等单词 onEvent 报告 end（发音结束）后再延迟 gap 毫秒朗读整句。
// 单词被中断 / 出错 / 取消时不再读整句。
function speakWordThenSentence(word, sentence, gap) {
  cancelSequence();
  if (!word) return;
  chrome.storage.local.get(DEFAULT_OPTIONS, (cfg: SpeakConfig) => {
    const base: SpeakOptions = {
      lang: DEFAULT_LANG,
      enqueue: false,
      volume: Math.min(Math.max(cfg.volume, 0), 100) / 100,
      rate: cfg.rate,
    };
    if (cfg.voiceName) base.voiceName = cfg.voiceName;
    chrome.tts.speak(word, {
      ...base,
      onEvent: (event) => {
        if (event.type === 'error') return;
        if (event.type !== 'end') return; // interrupted/cancelled 等：不再读整句
        if (!sentence) return;
        sequenceTimer = setTimeout(() => {
          sequenceTimer = null;
          chrome.tts.speak(sentence, { ...base });
        }, gap);
      },
    } as SpeakOptions);
  });
}

// 调试：打印可用英文语音，并推断默认英文语音。
function debugVoices() {
  getEnglishVoices().then((enVoices) => {
    if (!enVoices.length) {
      console.log('[EchoWord] 未找到英文语音，请检查系统是否安装了英文 TTS 语音。');
      return;
    }
    const defaultVoice = enVoices.find((v) => !v.remote) || enVoices[0];
    console.log(`[EchoWord] 英文(en)语音共 ${enVoices.length} 个：`);
    enVoices.forEach((v, i) => {
      console.log(`  ${i}. name="${v.voiceName}" lang="${v.lang}" remote=${v.remote}`);
    });
    console.log(
      `[EchoWord] 默认英文(${DEFAULT_LANG})语音 → "${defaultVoice.voiceName}" (remote=${defaultVoice.remote})`
    );
  });
}

chrome.runtime.onInstalled.addListener(debugVoices);
debugVoices();

// ---------- 词典查询（必应词典） ----------
//
// 悬停卡片里的音标、释义、例句来自必应词典。请求地址与页面解析
// 均参考 Saladict（cn.bing.com/dict/clientsearch，ClientVer 为移动/桌面端应用版本）。
// MV3 service worker 没有 DOMParser，抓到的 HTML 交给离屏文档（offscreen.html）
// 解析，结果做内存 + storage.local 双层缓存，避免悬停频繁请求触发限流。

const DICT_URL =
  'https://cn.bing.com/dict/clientsearch?mkt=zh-CN&setLang=zh&form=BDVEHC&ClientVer=BDDTV3.5.1.4320&q={q}';
const DICT_CACHE_KEY = 'dictCache';
const DICT_CACHE_MAX = 300; // 持久化缓存条数上限

const dictCache = new Map(); // word -> { data, ts }
let dictCacheLoaded = false;

// 把 storage 里的词典缓存加载到内存（仅一次）。
async function ensureDictCache() {
  if (dictCacheLoaded) return;
  dictCacheLoaded = true;
  try {
    const { [DICT_CACHE_KEY]: stored } = (await chrome.storage.local.get({
      [DICT_CACHE_KEY]: {},
    })) as { [key: string]: { data?: unknown; ts?: number } | undefined };
    for (const [word, entry] of Object.entries(stored || {})) {
      if (entry && (entry as { data?: unknown }).data) dictCache.set(word, entry);
    }
  } catch (e) {
    // 读取失败仅影响预热，后续仍可用内存缓存。
  }
}

// 持久化内存缓存：按最近使用时间排序，只保留最近 DICT_CACHE_MAX 条。
async function persistDictCache() {
  const entries = [...dictCache.entries()]
    .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0))
    .slice(0, DICT_CACHE_MAX);
  const obj = {};
  for (const [word, entry] of entries) obj[word] = entry;
  try {
    await chrome.storage.local.set({ [DICT_CACHE_KEY]: obj });
  } catch (e) {
    // 持久化失败不影响本次查询结果。
  }
}

// 确保离屏文档存在。service worker 空闲被回收后离屏文档可能随之关闭，
// 因此每次解析前都检查一次，缺失则重建。
async function ensureOffscreen() {
  // 新版 Chrome 用 hasDocument()（旧版 getDocuments() 已从 Chrome 移除）。
  const exists = await chrome.offscreen.hasDocument();
  if (exists) return;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('/offscreen.html'),
    reasons: ['DOM_PARSER'],
    justification: '在离屏文档中用 DOMParser 解析必应词典返回的 HTML（MV3 service worker 无 DOMParser）',
  });
}

// 把 HTML 交给离屏文档解析，返回 { us, uk, defs, examples } 或 null。
// 消息通道连不上（离屏文档刚被回收）时，关闭残留文档重建并重试一次。
async function parseDictInOffscreen(html) {
  const trySend = (): Promise<{ ok: boolean; res?: any }> =>
    chrome.runtime
      .sendMessage({ type: 'parseDictHtml', html })
      .then((res: any) => ({ ok: true, res }))
      .catch(() => ({ ok: false }));

  await ensureOffscreen();
  let r = await trySend();
  if (!r.ok) {
    await chrome.offscreen.closeDocument().catch(() => { });
    await ensureOffscreen();
    r = await trySend();
  }
  return r.ok ? (r.res && r.res.data) : null;
}

// 查询单词：先查缓存，未命中则抓取必应词典并解析。
async function lookupWord(word) {
  await ensureDictCache();

  const hit = dictCache.get(word);
  if (hit) {
    hit.ts = Date.now();
    return hit.data;
  }

  const url = DICT_URL.replace('{q}', encodeURIComponent(word));
  const res = await fetch(url, {
    headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
  });
  if (!res.ok) return null;

  const html = await res.text();
  const data = await parseDictInOffscreen(html);
  if (!data) return null;

  dictCache.set(word, { data, ts: Date.now() });
  persistDictCache(); // 异步持久化，不阻塞返回
  return data;
}

// ---------- 整句翻译（谷歌 / 必应，可在设置里选择） ----------
//
// 悬停卡片里的句子中文译文默认来自谷歌翻译免费接口（见 docs/api.md），
// 也可在设置中切换为必应翻译（v3 接口，见下方 bingTranslate）。
// 接口 en→zh，整句传入时返回译文。

const TRANSLATE_URL =
  'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh&hl=en-US&dt=t&dt=bd&dt=md&dt=ss&dt=ex&dj=1&source=bubble&q={q}';

async function googleTranslate(text) {
  const url = TRANSLATE_URL.replace('{q}', encodeURIComponent(text));
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const trans = (json?.sentences || [])
    .map((s) => (s && typeof s.trans === 'string' ? s.trans : ''))
    .join('');
  return trans || null;
}

// ---------- 必应翻译（ttranslatev3） ----------
//
// 参考 bing-translate-api（github.com/plainheart/bing-translate-api）：
// 1. 先抓取翻译页面解析 IG、IID 与 params_AbusePreventionHelper
//    （[token 创建时间戳, token, 有效期毫秒]）。首次从 https://bing.com/translator
//    发起，跟随重定向后取得实际子域（大陆为 cn.bing.com），之后沿用该子域；
//    得到的主机同时用于后续的 v3 接口请求。
// 2. 再向 https://{host}/ttranslatev3 POST 表单拿到译文。
// token 有有效期，过期后重新抓取一次（成功后缓存）。
// 注意：ttranslatev3 会拒绝非浏览器 UA 的请求；扩展 service worker 的
// fetch 默认携带 Chrome 真实 UA，无需手动设置（浏览器禁止覆写该头）。

const BING_TRANSLATOR_URL = 'https://bing.com/translator';

let bingConfig = null; // { host, IG, IID, key, token, tokenExpiryInterval }
let bingConfigPromise = null;

async function fetchBingConfig() {
  // 首次用 bing.com，之后沿用已取得的子域（避免每次都重定向）。
  const url = bingConfig
    ? `https://${bingConfig.host}/translator`
    : BING_TRANSLATOR_URL;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`必应翻译页面 ${res.status}`);
  const html = await res.text();

  // 跳转后主机（大陆为 cn.bing.com），API 请求沿用同一主机。
  const host = new URL(res.url).hostname;
  const IG = html.match(/IG:"([^"]+)"/)?.[1];
  const IID = html.match(/data-iid="([^"]+)"/)?.[1];
  const m = html.match(/params_AbusePreventionHelper\s*=\s*(\[[^\]]+\])/);
  if (!IG || !IID || !m) throw new Error('必应翻译参数解析失败');

  // [key(时间戳), token, tokenExpiryInterval(毫秒)]
  const [key, token, tokenExpiryInterval] = JSON.parse(m[1]);
  return { host, IG, IID, key, token, tokenExpiryInterval };
}

// 返回配置；缺失或过期时重新抓取。并发的多次调用共享同一次抓取。
function ensureBingConfig() {
  const expired =
    !bingConfig ||
    Date.now() - bingConfig.key > bingConfig.tokenExpiryInterval;
  if (!expired) return Promise.resolve(bingConfig);
  if (!bingConfigPromise) {
    bingConfigPromise = fetchBingConfig()
      .then((c) => {
        bingConfig = c;
        bingConfigPromise = null;
        return c;
      })
      .catch((e) => {
        bingConfigPromise = null;
        throw e;
      });
  }
  return bingConfigPromise;
}

async function bingTranslate(text) {
  const { host, IG, IID, key, token } = await ensureBingConfig();
  const url = `https://${host}/ttranslatev3?isVertical=1&IG=${IG}&IID=${IID}`;
  const body = new URLSearchParams({
    fromLang: 'en',
    to: 'zh-Hans',
    text,
    token,
    key: String(key),
    tryFetchingGenderDebiasedTranslations: 'true',
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body,
  });
  if (!res.ok) return null;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('json')) return null; // 性别去偏等特殊响应（HTML），忽略
  const json = await res.json();
  const trans = json?.[0]?.translations?.[0]?.text;
  return typeof trans === 'string' && trans ? trans : null;
}

// 按设置选择翻译引擎，默认谷歌。
async function translateSentence(text) {
  const { translator } = await chrome.storage.local.get({ translator: 'google' });
  return translator === 'bing' ? bingTranslate(text) : googleTranslate(text);
}

// 点击工具栏图标打开 popup.html（见 manifest 的 action.default_popup），
// 完整设置由弹窗内的「打开完整设置」入口进入。

// ---------- 单词本 ----------
//
// 收藏单词 + 例句（整句、中文译文）+ 出处 URL，并快照音标 / 释义，离线可回顾。
// 一词一条（wordKey 去重），每个来源 = (word, url) 唯一一次收藏；
// 同 (word, url) 再收藏 = 更新该来源，无来源时删除整条词条。
// 所有写入经 promise 链串行化，避免并发 read-modify-write 竞争。

const WORDBOOK_KEY = 'wordbook';
const WORDBOOK_MAX_ENTRIES = 2000; // 词条软上限，守护 storage.local 10MB 配额

type WbSource = {
  sid: string; // (word, url) 稳定 id，保存时由 djb2 哈希生成，幂等
  url: string;
  title?: string;
  sentence: string;
  trans: string;
  ts: number;
};
type WbEntry = {
  word: string; // 展示形式（首次捕获的原始单词）
  ts: number; // 首次收藏时间（词条级，分组展示用；来源级另有各自更新时间）
  us: string; // 音标快照（查询失败为 ''）
  uk: string;
  defs: { pos: string; defs: string[] }[];
  sources: WbSource[];
};
type WbMap = { [wordKey: string]: WbEntry };

// 词典快照按 context 分开缓存：悬停急查与单词本后台快照的传播独立。
// 实际直接复用 lookupWord 的双层缓存（dictCache），命中即快照、未命中补抓。

// djb2 字符串哈希的十六进制串（固定 8 位）。sid 稳定可重现，双击幂等。
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// 词条归一化键：小写、撇号统一为 ASCII '、trim；与 content 的 WORD_CHAR 同源口径。
function wordKeyOf(word) {
  return String(word || '')
    .toLowerCase()
    .replace(/[’]/g, "'")
    .trim();
}

// 来源 id：由 wordKey + URL（去 hash 后 origin+path+search）+ 例句派生。
// 同词同页的「不同例句」各自一条来源（可收藏多句），同一句再次收藏幂等。
function sourceSidOf(wordKey, url, sentence) {
  let base = url || '';
  try {
    const u = new URL(base);
    u.hash = '';
    base = u.origin + u.pathname + u.search;
  } catch {
    // 非 URL 字符串原样使用
  }
  return 's' + djb2(wordKey + '|' + base + '|' + sentence);
}

// 从 URL 剔除 reveal 参数，并去掉尾部多余的 ? 或 &，防止 toggle 状态因参数残留而漂移。
function canonicalPageUrl(url) {
  let s = String(url || '');
  try {
    const u = new URL(s);
    u.searchParams.delete('echoword_reveal');
    let qs = u.searchParams.toString();
    s = u.origin + u.pathname + (qs ? '?' + qs : '') + u.hash;
  } catch {
    // 非 URL 字符串原样返回
  }
  return s;
}

// 串行化单词本写入：所有 add/remove/delete 都进同一个 promise 链。
let wordbookQueue: Promise<unknown> = Promise.resolve();
function enqueueWb<T>(fn: () => Promise<T>): Promise<T> {
  const run = wordbookQueue.then(fn, fn);
  // 失败不能打断链，吞掉错误但把结果传给调用方。
  wordbookQueue = run.catch(() => { });
  return run;
}

// 读取整个单词本（attempt 到失败则回落为空对象）。
async function readWordbook(): Promise<WbMap> {
  const { [WORDBOOK_KEY]: stored } = (await chrome.storage.local.get({
    [WORDBOOK_KEY]: {},
  })) as { [k: string]: WbMap };
  return stored && typeof stored === 'object' ? stored : {};
}

// 持久化前裁掉超限的旧词条：按各词条来源的最近 ts 排序，保最活跃的。
function clampWordbook(wb: WbMap): WbMap {
  const keys = Object.keys(wb);
  if (keys.length <= WORDBOOK_MAX_ENTRIES) return wb;
  const latest = (e: WbEntry) =>
    e.sources.reduce((m, s) => Math.max(m, s.ts || 0), 0);
  const keep = keys
    .sort((a, b) => latest(wb[b]) - latest(wb[a]))
    .slice(0, WORDBOOK_MAX_ENTRIES);
  const next: WbMap = {};
  for (const k of keep) next[k] = wb[k];
  return next;
}

// 收藏：合并来源 + 兜底快照（例句译文缺失时补翻、音标/释义缺失时补查词典）。
async function wordbookAdd(word, sentence, trans, url, title) {
  const wk = wordKeyOf(word);
  if (!wk) return { saved: false };
  const sid = sourceSidOf(wk, url, sentence);
  const now = Date.now();
  const cleanUrl = canonicalPageUrl(url);

  // 译文为空时兜底翻译一次；音标/释义缺失时兜底查词典（lookupWord 自带 LRU 缓存）。
  let trans2 = typeof trans === 'string' ? trans.trim() : '';
  if (!trans2 && sentence) {
    trans2 = (await translateSentence(sentence).catch(() => null)) || '';
  }

  const wb = await readWordbook();
  const entry = wb[wk] || {
    word: word,
    ts: now, // 首次收藏的时间，之后不再更新（新增来源不改词条加日期）
    us: '',
    uk: '',
    defs: [],
    sources: [],
  };

  // 词条级音标/释义快照只在缺失时补：已保存过的不被后来再次的失败覆盖。
  if (!entry.us && !entry.uk && !entry.defs.length) {
    const data = await lookupWord(word).catch(() => null);
    if (data) {
      entry.us = data.us || '';
      entry.uk = data.uk || '';
      entry.defs = data.defs || [];
    }
  }

  const prevSource = entry.sources.find((s) => s.sid === sid);
  const source: WbSource = {
    sid,
    url: cleanUrl,
    title: typeof title === 'string' ? title : undefined,
    sentence: sentence || word,
    trans: trans2,
    ts: now,
  };
  // 同 sid（同词同页同句）已存在则更新例句快照，否则新增一条（同页多例句并存）。
  if (prevSource) {
    entry.sources = entry.sources.map((s) => (s.sid === sid ? source : s));
  } else {
    entry.sources.push(source);
  }

  wb[wk] = entry;
  try {
    await chrome.storage.local.set({ [WORDBOOK_KEY]: clampWordbook(wb) });
  } catch (e) {
    return { saved: false };
  }
  return { saved: true };
}

// 从收藏中移除一条来源，按 sid 精确匹配（同页多例句时只取消当前句）。
// 弹窗取消收藏时由 (word, url, sentence) 推导出同一个 sid（收藏/取消幂等）。
// 来源删空时整条删除。
async function wordbookRemove(word, url, sentence) {
  const wk = wordKeyOf(word);
  if (!wk) return { saved: false };
  const wb = await readWordbook();
  const entry = wb[wk];
  if (!entry) return { saved: false };
  const sid = sourceSidOf(
    wk,
    canonicalPageUrl(url),
    typeof sentence === 'string' ? sentence : ''
  );
  const before = entry.sources.length;
  entry.sources = entry.sources.filter((s) => s.sid !== sid);
  if (entry.sources.length === before) return { saved: false };
  const wordSaved = entry.sources.length > 0;
  if (!wordSaved) delete wb[wk];
  try {
    await chrome.storage.local.set({ [WORDBOOK_KEY]: wb });
  } catch (e) {
    return { saved: false };
  }
  return { saved: true, wordSaved };
}

// 删除整条词条（单词本页用）。
async function wordbookDeleteWord(wordKey) {
  const wb = await readWordbook();
  delete wb[wordKey];
  try {
    await chrome.storage.local.set({ [WORDBOOK_KEY]: wb });
  } catch (e) {
    return { ok: false };
  }
  return { ok: true };
}

// 导入：与现有词条按 wordKey 合并、来源按 sid 去重；同 sid 冲突时保留 ts 较新者。
// 词条级快照（音标/释义）在冲突时也采较新来源所属词条的字段，其余字段取既有值兜底。
// 合并结果经 clampWordbook 收口，防止导入超过软上限。
async function wordbookImport(data) {
  if (!data || typeof data !== 'object' || typeof data.entries !== 'object')
    return { ok: false };
  const now = Date.now();
  const wb = await readWordbook();
  let imported = 0;
  for (const item of Object.values(data.entries)) {
    const e = item as WbEntry;
    const wk = wordKeyOf(e?.word);
    if (!wk || !Array.isArray(e?.sources)) continue;
    const sources: WbSource[] = [];
    for (const s of e.sources) {
      if (!s || typeof s !== 'object' || !s.sid) continue;
      sources.push({
        sid: String(s.sid),
        url: String(s.url || ''),
        title: typeof s.title === 'string' ? s.title : undefined,
        sentence: String(s.sentence || ''),
        trans: String(s.trans || ''),
        ts: Number(s.ts) || now,
      });
    }
    if (!sources.length) continue;
    const existing = wb[wk];
    const incoming = {
      word: String(e.word),
      // 缺失 ts 时兜底 now，导入条目排在时间线尾部
      ts: Number(e.ts) || now,
      us: String(e.us || ''),
      uk: String(e.uk || ''),
      defs: Array.isArray(e.defs)
        ? e.defs
            .filter((d) => d && typeof d === 'object')
            .map((d) => ({
              pos: String(d.pos || ''),
              defs: Array.isArray(d.defs) ? d.defs.map(String) : [],
            }))
        : [],
      sources,
    };
    if (!existing) {
      wb[wk] = incoming;
      imported += sources.length;
      continue;
    }
    const entry = existing;
    const latestOf = (list: WbSource[]) =>
      list.reduce((m, s) => Math.max(m, s.ts || 0), 0);
    // 词条级快照采 ts 较新完整侧；一方缺失时用另一侧兜底
    if (latestOf(incoming.sources) >= latestOf(entry.sources)) {
      entry.word = entry.word || incoming.word;
      entry.ts = entry.ts || incoming.ts;
      entry.us = entry.us || incoming.us;
      entry.uk = entry.uk || incoming.uk;
      entry.defs = entry.defs.length ? entry.defs : incoming.defs;
    } else {
      entry.us = incoming.us || entry.us;
      entry.uk = incoming.uk || entry.uk;
      entry.defs = incoming.defs.length ? incoming.defs : entry.defs;
    }
    for (const s of incoming.sources) {
      const prev = entry.sources.find((x) => x.sid === s.sid);
      if (!prev) {
        entry.sources.push(s);
        imported += 1;
      } else if ((s.ts || 0) > (prev.ts || 0)) {
        entry.sources = entry.sources.map((x) => (x.sid === s.sid ? s : x));
      }
    }
    wb[wk] = entry;
  }
  try {
    await chrome.storage.local.set({ [WORDBOOK_KEY]: clampWordbook(wb) });
  } catch (e) {
    return { ok: false };
  }
  return { ok: true, imported };
}

// 按词条键与来源 id 精确删除一条来源（单词本页逐句删除用）。
async function wordbookRemoveSource(wordKey, sid) {
  const wb = await readWordbook();
  const entry = wb[wordKey];
  if (!entry) return { ok: false };
  const before = entry.sources.length;
  entry.sources = entry.sources.filter((s) => s.sid !== sid);
  if (entry.sources.length === before) return { ok: false };
  if (!entry.sources.length) delete wb[wordKey];
  try {
    await chrome.storage.local.set({ [WORDBOOK_KEY]: wb });
  } catch (e) {
    return { ok: false };
  }
  return { ok: true };
}

// 全量词条，按首次收藏时间降序。单词本页按 entry.ts 分组展示日期，
// 排序必须用同一口径——若按来源最新活动时间排序，旧词条今天补了例句
// 会被顶到最前，却分组在旧日期下，日期标题就会来回交替。
function sortedWordbook(wb: WbMap) {
  return Object.entries(wb)
    .map(([wordKey, entry]) => ({ wordKey, ...entry }))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'speak') {
    // 新的单次朗读会取消上一个未触发的整句（见 speakWordThenSentence）。
    cancelSequence();
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!text) return;
    const voiceOverride =
      typeof message.voiceName === 'string' && message.voiceName
        ? message.voiceName
        : null;
    speakText(text, voiceOverride);
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === 'speakSequence') {
    const word = typeof message.text === 'string' ? message.text.trim() : '';
    if (!word) {
      sendResponse({ ok: false });
      return;
    }
    const sentence =
      typeof message.sentence === 'string' ? message.sentence.trim() : '';
    const gap = Math.max(0, Number(message.gap) || 0);
    speakWordThenSentence(word, sentence, gap);
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === 'stop') {
    cancelSequence();
    chrome.tts.stop();
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === 'getVoices') {
    getEnglishVoices().then((voices) => sendResponse({ voices }));
    return true; // 异步响应，保持消息通道
  }

  if (message?.type === 'debug') {
    debugVoices();
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === 'lookup') {
    const word = typeof message.word === 'string' ? message.word.trim() : '';
    if (!word) {
      sendResponse({ ok: false });
      return;
    }
    lookupWord(word)
      .then((data) => sendResponse({ ok: true, data }))
      .catch(() => sendResponse({ ok: false }));
    return true; // 异步响应，保持消息通道
  }

  if (message?.type === 'translate') {
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!text) {
      sendResponse({ ok: false });
      return;
    }
    translateSentence(text)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false }));
    return true; // 异步响应，保持消息通道
  }

  // ---------- 单词本 ----------
  // 全部 async，统一 return true 保活消息通道。

  if (message?.type === 'wordbookCheck') {
    const wk = wordKeyOf(message.word);
    if (!wk) {
      sendResponse({ ok: false });
      return true;
    }
    readWordbook()
      .then((wb) => {
        const entry = wb[wk];
        const wordSaved = !!entry;
        // 按 (页 URL, 例句) 精确匹配：同页不同例句各自有收藏状态。
        const sid = sourceSidOf(
          wk,
          canonicalPageUrl(message.url),
          typeof message.sentence === 'string' ? message.sentence : ''
        );
        sendResponse({
          ok: true,
          saved: !!(entry && entry.sources.some((s) => s.sid === sid)),
          wordSaved,
        });
      })
      .catch(() => sendResponse({ ok: false, saved: false }));
    return true;
  }

  if (message?.type === 'wordbookAdd') {
    enqueueWb(() =>
      wordbookAdd(message.word, message.sentence, message.trans, message.url, message.title)
    )
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch(() => sendResponse({ ok: false, saved: false }));
    return true;
  }

  if (message?.type === 'wordbookRemove') {
    enqueueWb(() => wordbookRemove(message.word, message.url, message.sentence))
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch(() => sendResponse({ ok: false, saved: false }));
    return true;
  }

  if (message?.type === 'wordbookGetData') {
    readWordbook()
      .then((wb) => sendResponse({ ok: true, data: sortedWordbook(wb) }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === 'wordbookGetSource') {
    readWordbook()
      .then((wb) => {
        for (const [wordKey, entry] of Object.entries(wb)) {
          const src = entry.sources.find((s) => s.sid === message.sid);
          if (src) {
            sendResponse({ ok: true, data: { wordKey, word: entry.word, sentence: src.sentence } });
            return;
          }
        }
        sendResponse({ ok: true, data: null });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === 'wordbookImport') {
    enqueueWb(() => wordbookImport(message.data))
      .then((res) => sendResponse(res))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === 'wordbookDeleteWord') {
    enqueueWb(() => wordbookDeleteWord(message.wordKey))
      .then((res) => sendResponse({ ok: res.ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === 'wordbookRemoveSource') {
    enqueueWb(() => wordbookRemoveSource(message.wordKey, message.sid))
      .then((res) => sendResponse({ ok: res.ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});
});
