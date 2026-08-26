// EchoWord — 后台服务：用 chrome.tts 朗读 content script 传来的文字。

const DEFAULT_LANG = 'en-US';
const DEFAULT_OPTIONS = { voiceName: '', volume: 100, rate: 1 };

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
  return new Promise((resolve) => {
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
  chrome.storage.local.get(DEFAULT_OPTIONS, (cfg) => {
    const options = {
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
  chrome.storage.local.get(DEFAULT_OPTIONS, (cfg) => {
    const base = {
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
    });
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
    const { [DICT_CACHE_KEY]: stored } = await chrome.storage.local.get({
      [DICT_CACHE_KEY]: {},
    });
    for (const [word, entry] of Object.entries(stored || {})) {
      if (entry && entry.data) dictCache.set(word, entry);
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
  // 新版 Chrome 用 hasDocument()，旧版用 getDocuments()（旧版已被移除）。
  const exists = chrome.offscreen.hasDocument
    ? await chrome.offscreen.hasDocument()
    : (await chrome.offscreen.getDocuments()).length > 0;
  if (exists) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: '在离屏文档中用 DOMParser 解析必应词典返回的 HTML（MV3 service worker 无 DOMParser）',
  });
}

// 把 HTML 交给离屏文档解析，返回 { us, uk, defs, examples } 或 null。
// 消息通道连不上（离屏文档刚被回收）时，关闭残留文档重建并重试一次。
async function parseDictInOffscreen(html) {
  const trySend = () =>
    chrome.runtime
      .sendMessage({ type: 'parseDictHtml', html })
      .then((res) => ({ ok: true, res }))
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
});
