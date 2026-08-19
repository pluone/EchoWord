// echo word — 悬停单词即弹出小卡片并朗读（已移除原来的「选中即朗读」）。
//
// 行为：
// - 鼠标悬停在英文单词上超过「悬停延迟」后弹出卡片（Shadow DOM），显示该单词与喇叭图标。
// - 点击喇叭图标（或开启「自动播放」后弹窗出现时）通过 chrome.tts 朗读。
// - 开启「整句朗读」时，朗读该单词所在的整句而非单个单词。
// - 开启「粘性弹窗」时，弹窗只在点击外部、点击 X 或按 Esc 后关闭；
//   否则鼠标移开单词即关闭。

const DEFAULT_OPTIONS = {
  hoverDelay: 600, // 毫秒；0 表示立即
  autoSpeak: false,
  sentenceSpeak: false,
  stickyPopup: false,
};

// 英文单词字符：字母、数字、撇号、连字符。
const WORD_CHAR = /[A-Za-z0-9'’\-]/;
const HAS_ALNUM = /[A-Za-z0-9]/;

// 光标吸附容差：caretPositionFromPoint 会把空白处的光标吸附到最近的文本，
// 只要光标落在单词包围盒外这个距离以内，仍视为悬停在单词上。
const POINT_TOLERANCE = 6; // px

let cfg = { ...DEFAULT_OPTIONS };
let currentWord = null; // { word, node, start, end }
let lastReadSentence = null; // 最近一次自动朗读所属的句子，用于同句内移动时避免重复朗读
let activeSentence = null; // 当前弹窗对应的句子，用于丢弃过期的整句翻译
let showTimer = null;
let hideTimer = null;
let visible = false;
let enabled = false; // 当前站点是否启用，随站点开关实时更新
const HOSTNAME = (location.hostname || '').toLowerCase();

// ---------- 弹窗宿主与 Shadow DOM ----------

const host = document.createElement('div');
host.setAttribute('data-echo-word', '');
// 内联样式统一加 !important，尽量抵抗页面样式对宿主的干扰。
const setHost = (prop, value) => host.style.setProperty(prop, value, 'important');
setHost('position', 'absolute');
setHost('z-index', '2147483647');
setHost('left', '0px');
setHost('top', '0px');
setHost('display', 'none');

const SPEAKER_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const CLOSE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
  '<path d="M18 6 6 18M6 6l12 12"/></svg>';

const shadow = host.attachShadow({ mode: 'open' });
shadow.innerHTML = `
<style>
  .popup {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 12px;
    background: #fff;
    color: #1a1a1a;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    line-height: 1.35;
    max-width: min(60vw, 420px);
    box-sizing: border-box;
  }
  /* 底边中央的向下小尖角，指向下方的单词。 */
  .popup::after {
    content: '';
    position: absolute;
    left: 50%;
    bottom: -6px;
    transform: translateX(-50%);
    border-left: 6px solid transparent;
    border-right: 6px solid transparent;
    border-top: 6px solid #fff;
  }
  /* 上方空间不足、弹窗翻转到单词下方时，尖角改为朝上。 */
  .popup.below::after {
    bottom: auto;
    top: -6px;
    border-top: none;
    border-bottom: 6px solid #fff;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .word {
    font-size: 15px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 40vw;
  }
  .phons {
    color: #666;
    font-size: 13px;
    white-space: nowrap;
    margin-left: auto; /* 音标靠右 */
  }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
    border-radius: 4px;
    color: #444;
    flex: none;
  }
  .btn:hover { background: rgba(0, 0, 0, 0.08); }
  .btn svg { width: 16px; height: 16px; display: block; }
  .close { color: #999; }
  .body {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-top: 1px solid rgba(0, 0, 0, 0.08);
    padding-top: 6px;
    margin-top: 2px;
  }
  .body[hidden] { display: none; }
  .def-line {
    font-size: 13px;
    line-height: 1.4;
    color: #333;
  }
  .def-line .pos {
    color: #1a73e8;
    font-weight: 600;
    margin-right: 4px;
  }
  .trans {
    font-size: 14px;
    line-height: 1.4;
    color: #1a1a1a;
  }
  .trans[hidden] { display: none; }
</style>
<div class="popup">
  <div class="head">
    <button class="btn speak" type="button" title="朗读" aria-label="朗读">${SPEAKER_SVG}</button>
    <span class="word"></span>
    <span class="phons"></span>
    <button class="btn close" type="button" title="关闭" aria-label="关闭">${CLOSE_SVG}</button>
  </div>
  <div class="body" hidden>
    <div class="defs"></div>
    <div class="trans" hidden></div>
  </div>
</div>
`;

const wordEl = shadow.querySelector('.word');
const phonsEl = shadow.querySelector('.phons');
const bodyEl = shadow.querySelector('.body');
const defsEl = shadow.querySelector('.defs');
const transEl = shadow.querySelector('.trans');
const speakBtn = shadow.querySelector('.speak');
const closeBtn = shadow.querySelector('.close');
const popupEl = shadow.querySelector('.popup');

(document.documentElement || document.body).appendChild(host);

// ---------- 工具 ----------

function isEditable(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
}

// 用 caretPositionFromPoint / caretRangeFromPoint 找到光标处的文本节点与偏移。
function caretAtPoint(x, y) {
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos && pos.offsetNode) return { node: pos.offsetNode, offset: pos.offset };
  } else if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    if (range) return { node: range.startContainer, offset: range.startOffset };
  }
  return null;
}

// 从光标位置扩展出所在的英文单词。
function wordAtPoint(x, y) {
  const pos = caretAtPoint(x, y);
  if (!pos || pos.node.nodeType !== Node.TEXT_NODE) return null;
  const text = pos.node.textContent || '';
  if (!text) return null;

  const isWordChar = (ch) => !!ch && WORD_CHAR.test(ch);
  // 光标若停在空白处（前后均非单词字符），视为没有悬停到单词。
  if (!isWordChar(text[pos.offset]) && !isWordChar(text[pos.offset - 1])) return null;

  let start = pos.offset;
  let end = pos.offset;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;

  const word = text.slice(start, end);
  if (!word || !HAS_ALNUM.test(word)) return null;

  // caretPositionFromPoint 会把空白处（左右页边、行间）的光标吸附到最近的文本，
  // 若不校验几何位置，鼠标在阅读区两侧空白与单词所在行平行时也会误触发朗读。
  const rect = rangeRect(pos.node, start, end);
  if (
    rect &&
    (x < rect.left - POINT_TOLERANCE ||
      x > rect.right + POINT_TOLERANCE ||
      y < rect.top - POINT_TOLERANCE ||
      y > rect.bottom + POINT_TOLERANCE)
  ) {
    return null;
  }

  return { word, node: pos.node, start, end };
}

// 文本范围 [start, end) 的包围盒；无法测量时返回 null。
function rangeRect(node, start, end) {
  try {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const r = range.getBoundingClientRect();
    if (r && (r.width || r.height)) return r;
  } catch (e) {
    // 忽略异常，由调用方决定兜底。
  }
  return null;
}

// ---------- 整句提取 ----------
//
// 从单词所在文本节点提取所在整句。句子可能跨多个文本节点
// （如 <span>Hello</span> <span>world.</span>），因此：
// 1. 以最近 block 级祖先为边界收集文本，避免跨段落拼接；
// 2. 识别常见缩写（Mr. / U.S. / e.g. 等），避免把缩写句点当句末；
// 3. 句子超过 MAX_SENTENCE_WORDS 个单词时，以当前词为中心截取。

const MAX_SENTENCE_WORDS = 30;
const MAX_BLOCK_TEXT = 8000; // block 文本收集上限，防止大页面卡顿
const MAX_BLOCK_NODES = 400; // block 节点访问上限，同上

// 永远按缩写处理：后面通常紧跟大写专名（Mr. Smith、St. Louis、Dr. Jones）。
const TITLE_ABBR = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'rev', 'hon', 'mme',
]);
// 仅在后面不是大写字母（新句开头）时才按缩写处理：
// U.S. army 是缩写句点，U.S. It is… 则是句末。
const OTHER_ABBR = new Set([
  'etc', 'vs', 'inc', 'ltd', 'co', 'corp', 'dept', 'approx',
  'u.s', 'u.k', 'u.n', 'e.u', 'e.g', 'i.e', 'a.m', 'p.m',
  'fig', 'no', 'vol', 'pp', 'cf', 'al', 'est',
]);

// 取 text[i] 这个句点之前的“词片段”（含句点，如 U.S、example.com），用于缩写判断。
function abbrToken(text, i) {
  let j = i - 1;
  while (j >= 0 && /[A-Za-z0-9'’.]/.test(text[j])) j--;
  return text.slice(j + 1, i);
}

// 判断 text[i] 是否为句末标点。句点需结合缩写判断，
// 避免把 Mr. / U.S. / e.g. / example.com 中的句点当成句末。
function isSentenceEnd(text, i) {
  const ch = text[i];
  if (!ch) return false;
  if (ch === '\n') return true;
  if (ch === '!' || ch === '?' || ch === '…') return true;
  if (ch !== '.') return false;

  // 句点后紧贴字母/数字（无空格）：多为 URL、小数或缩写的一部分。
  const next = text[i + 1];
  if (next && /[A-Za-z0-9]/.test(next)) return false;

  const token = abbrToken(text, i);
  if (!token) return false;
  const lower = token.toLowerCase();
  if (TITLE_ABBR.has(lower)) return false; // Mr. / Dr. 等
  if (OTHER_ABBR.has(lower)) {
    // 后面跟大写字母（或到文本末尾）时，该句点同时充当句号，否则只是缩写。
    let k = i + 1;
    while (k < text.length && (/\s/.test(text[k]) || /["')\]»”’」』]/.test(text[k]))) k++;
    return k >= text.length || /[A-Z]/.test(text[k]);
  }
  if (/^[A-Z](\.?[A-Z])*$/.test(token)) return false; // J. / U.S. 式大写缩写
  return true;
}

// 是否算作 block 级元素：句子遍历的边界，避免跨段落获取不相关文本。
function isBlockLevel(el) {
  if (!el || el === document.body || el === document.documentElement) return true;
  const tag = el.tagName;
  if (
    tag === 'P' || tag === 'DIV' || tag === 'LI' || tag === 'TD' || tag === 'TH' ||
    tag === 'SECTION' || tag === 'ARTICLE' || tag === 'ASIDE' || tag === 'HEADER' ||
    tag === 'FOOTER' || tag === 'NAV' || tag === 'MAIN' || tag === 'BLOCKQUOTE' ||
    tag === 'FIGURE' || tag === 'FIGCAPTION' || tag === 'UL' || tag === 'OL' ||
    tag === 'DL' || tag === 'TABLE' || tag === 'FORM' || tag === 'FIELDSET' ||
    tag === 'ADDRESS' || tag === 'PRE' || tag === 'HR' || tag === 'DD' ||
    tag === 'DT' || tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' ||
    tag === 'H5' || tag === 'H6'
  ) {
    return true;
  }
  const d = getComputedStyle(el).display;
  return (
    d.startsWith('block') || d === 'flow-root' || d === 'list-item' ||
    d.startsWith('flex') || d.startsWith('grid') || d.startsWith('table')
  );
}

// 按文档顺序收集 block 内可见文本（<br> 记作换行），并返回目标文本节点
// 在拼接文本中的起始偏移。目标不可达或超限被截断时返回 -1。
function blockTextAndOffset(block, targetNode) {
  let full = '';
  let targetOffset = -1;
  let visited = 0;

  const walk = (el) => {
    if (full.length >= MAX_BLOCK_TEXT || visited >= MAX_BLOCK_NODES) return;
    const children = el.childNodes;
    for (let i = 0; i < children.length; i++) {
      if (full.length >= MAX_BLOCK_TEXT || visited >= MAX_BLOCK_NODES) return;
      visited++;
      const child = children[i];
      if (child.nodeType === Node.TEXT_NODE) {
        if (child === targetNode) targetOffset = full.length;
        full += child.textContent || '';
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName;
        if (tag === 'BR') {
          full += '\n';
          continue;
        }
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') {
          continue;
        }
        const style = getComputedStyle(child);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        walk(child);
      }
    }
  };

  walk(block);
  return { full, targetOffset };
}

// 句末标点之后紧随的闭合引号/括号（如 …。" 的引号）一并算作句尾。
function skipClosers(text, i) {
  let j = i + 1;
  while (j < text.length && /["')\]»”’」』]/.test(text[j])) j++;
  return j;
}

// 去掉句子首尾的空白与引号/括号（如 (…) 或 …。" ），返回清理后的文本
// 与去掉的前缀长度（供 30 词截取计算当前词偏移）。
function cleanSentence(str) {
  let lo = 0;
  let hi = str.length;
  while (lo < hi && /[\s"'`(\[«“「『]/.test(str[lo])) lo++;
  while (hi > lo && /[\s"'`)\]»”’」』]/.test(str[hi - 1])) hi--;
  return { text: str.slice(lo, hi), lead: lo };
}

// 句子超过 MAX_SENTENCE_WORDS 个单词时，以当前词为中心截取最多 30 个词。
function capSentence(sentence, wordStart, wordEnd) {
  const tokens = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(sentence)) !== null) {
    tokens.push({ start: m.index, end: m.index + m[0].length });
  }
  if (tokens.length <= MAX_SENTENCE_WORDS) return sentence;

  let center = tokens.findIndex((t) => t.start <= wordStart && wordStart < t.end);
  if (center < 0) center = Math.floor(tokens.length / 2);

  let lo = Math.max(0, center - Math.floor(MAX_SENTENCE_WORDS / 2));
  let hi = Math.min(tokens.length, lo + MAX_SENTENCE_WORDS);
  lo = Math.max(0, hi - MAX_SENTENCE_WORDS);

  return sentence.slice(tokens[lo].start, tokens[hi - 1].end).trim();
}

// 从单词所在文本节点提取整句。
function sentenceFromWord(info) {
  // 最近 block 级祖先即遍历边界，避免跨段落获取不相关文本。
  let block = info.node.parentElement;
  while (block && !isBlockLevel(block)) block = block.parentElement;
  if (!block) block = document.body;

  const { full, targetOffset } = blockTextAndOffset(block, info.node);

  // 目标节点不可达时，退回单词所在文本节点内的单节点提取。
  const text = targetOffset < 0 ? info.node.textContent || '' : full;
  const wordStart = targetOffset < 0 ? info.start : targetOffset + info.start;
  const wordEnd = targetOffset < 0 ? info.end : targetOffset + info.end;

  // 向前找句首：从当前词往前找最近一次句末标点。
  let s = 0;
  for (let i = wordStart - 1; i >= 0; i--) {
    if (isSentenceEnd(text, i)) {
      s = skipClosers(text, i);
      break;
    }
  }
  // 向后找句尾：从当前词往后找下一次句末标点（含标点本身）。
  let e = text.length;
  for (let i = wordEnd; i < text.length; i++) {
    if (isSentenceEnd(text, i)) {
      e = skipClosers(text, i);
      break;
    }
  }

  const raw = text.slice(s, e);
  const { text: sentence, lead } = cleanSentence(raw);
  if (!sentence) return info.word;
  return capSentence(sentence, wordStart - s - lead, wordEnd - s - lead);
}

// ---------- 朗读 ----------

function speakFor(info, sentence) {
  const text = cfg.sentenceSpeak ? sentence || sentenceFromWord(info) : info.word;
  if (!text) return;
  chrome.runtime.sendMessage({ type: 'speak', text }).catch(() => { });
}

// ---------- 弹窗显示 / 隐藏 ----------

function renderPopup(word) {
  wordEl.textContent = word;
  phonsEl.textContent = '';
  defsEl.textContent = '';
  transEl.textContent = '';
  transEl.hidden = true;
  bodyEl.hidden = true;
}

// ---------- 词典释义 ----------
//
// 悬停时向后台请求必应词典释义，异步填充音标 / 释义。
// 结果按单词缓存在本地，避免反复悬停同一单词时重复请求。

const dictCache = new Map(); // 单词 -> 结构化数据（null 表示查无结果，一并缓存）

function lookupDict(word) {
  if (dictCache.has(word)) return Promise.resolve(dictCache.get(word));
  return chrome.runtime
    .sendMessage({ type: 'lookup', word })
    .then((res) => {
      console.log('lookupDict', word, JSON.stringify(res));
      const data = res && res.ok ? res.data : null;
      dictCache.set(word, data);
      return data;
    })
    .catch(() => {
      dictCache.set(word, null);
      return null;
    });
}

function loadDict(word) {
  lookupDict(word).then((data) => {
    // 弹窗可能已隐藏或已切到别的单词，丢弃过期结果。
    if (!visible || !currentWord || currentWord.word !== word) return;
    console.log('loadDict', word, JSON.stringify(data));
    renderDict(data);
  });
}

function renderDict(data) {
  if (!data) return; // 查无结果：保持仅显示单词

  // 音标：英在前、美在后，与必应页面一致。
  const phons = [];
  if (data.uk) phons.push(`英[${data.uk}]`);
  if (data.us) phons.push(`美[${data.us}]`);
  phonsEl.textContent = phons.join(' ');

  // 释义：每条一行「词性 + 释义」。
  defsEl.textContent = '';
  for (const d of (data.defs || []).slice(0, 4)) {
    const line = document.createElement('div');
    line.className = 'def-line';
    const pos = document.createElement('span');
    pos.className = 'pos';
    pos.textContent = d.pos ? d.pos + ' ' : '';
    const def = document.createElement('span');
    def.className = 'def';
    def.textContent = (d.defs || []).join('；');
    line.append(pos, def);
    defsEl.appendChild(line);
  }

  updateBodyVisibility();
}

// ---------- 整句翻译 ----------
//
// 悬停时向后台请求谷歌翻译，把单词所在整句译成中文，显示在释义下方。
// 结果按句子缓存在本地，避免反复悬停同一句子时重复请求。
// 仅缓存成功的译文：null 多为接口瞬时报错，缓存会掩盖可恢复的失败。

const translateCache = new Map(); // 句子 -> 译文（只缓存成功结果）

function lookupTranslation(sentence) {
  if (translateCache.has(sentence)) return Promise.resolve(translateCache.get(sentence));
  return chrome.runtime
    .sendMessage({ type: 'translate', text: sentence })
    .then((res) => {
      console.log('lookupTranslation', JSON.stringify(res));
      const data = res && res.ok ? res.data : null;
      if (data) translateCache.set(sentence, data);
      return data;
    })
    .catch(() => null);
}

function loadTranslation(sentence) {
  lookupTranslation(sentence).then((trans) => {
    // 弹窗可能已隐藏或已切到别的句子，丢弃过期结果。
    if (!visible || activeSentence !== sentence) return;
    console.log('loadTranslation', sentence, JSON.stringify(trans));
    renderTranslation(trans);
  });
}

function renderTranslation(trans) {
  if (!trans) return; // 翻译失败或为空：保持仅显示释义
  transEl.textContent = trans;
  transEl.hidden = false;
  updateBodyVisibility();
}

// phons / defs / trans 任一有内容即显示 .body，内容变化后重新定位弹窗。
// 词典与翻译异步返回的顺序不定，统一由此处判断显隐，避免互相覆盖。
function updateBodyVisibility() {
  const hasBody = phonsEl.textContent || defsEl.childNodes.length || !transEl.hidden;
  bodyEl.hidden = !hasBody;
  positionPopup(currentWord);
}

// 把弹窗按页面坐标钉在单词上方。弹窗用 absolute 定位随页面一起滚动，
// 由浏览器合成器与单词同步移动：滚动时无需逐帧重新测量，也不会 JS 重定位抖动，
// 滚到视口边界时会被视口自然裁切、逐渐隐藏。
function positionPopup(info) {
  setHost('display', 'block');
  setHost('left', '0px');
  setHost('top', '0px');

  const rect = host.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  const pad = 8;
  const gap = 6; // 尖角与单词之间的间距

  const wr = rangeRect(info.node, info.start, info.end);
  if (!wr) {
    // 单词已无法测量（如节点被移除），不显示弹窗。
    setHost('display', 'none');
    return;
  }

  // 页面坐标 = 视口坐标 + 滚动偏移。
  const scrollX = window.scrollX || window.pageXOffset || 0;
  const scrollY = window.scrollY || window.pageYOffset || 0;

  const cx = wr.left + scrollX + wr.width / 2; // 单词水平中心（页面坐标）
  let left = cx - w / 2;
  left = Math.max(pad + scrollX, Math.min(left, scrollX + window.innerWidth - w - pad));

  // 优先放在单词正上方；上方视口空间不足时翻转到单词下方。
  const above = wr.top - h - gap >= pad;
  const top = above
    ? wr.top + scrollY - h - gap
    : wr.top + scrollY + wr.height + gap;

  popupEl.classList.toggle('below', !above);

  setHost('left', left + 'px');
  setHost('top', top + 'px');
}

function showPopup(info) {
  renderPopup(info.word);
  positionPopup(info);
  visible = true;
  // 所在整句：整句翻译与整句朗读共用，只提取一次。
  const sentence = sentenceFromWord(info);
  activeSentence = sentence;
  loadTranslation(sentence);
  loadDict(info.word);
  if (!cfg.autoSpeak) return;
  if (!cfg.sentenceSpeak) {
    // 未开启整句朗读：移到不同单词就直接朗读该单词。
    speakFor(info);
    return;
  }
  // 整句朗读：同句内移动不重复朗读，仅切换到不同句子时才朗读。
  if (sentence !== lastReadSentence) {
    speakFor(info, sentence);
    lastReadSentence = sentence;
  }
}

function hidePopup() {
  if (!visible) return;
  visible = false;
  setHost('display', 'none');
  currentWord = null;
  lastReadSentence = null;
  activeSentence = null;
  clearShow();
  clearHide();
}

function clearShow() {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
}

function clearHide() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function scheduleShow(info) {
  clearShow();
  clearHide();
  if (cfg.hoverDelay === 0) {
    showPopup(info);
  } else {
    showTimer = setTimeout(() => {
      showTimer = null;
      showPopup(info);
    }, cfg.hoverDelay);
  }
}

// 鼠标移开单词：非粘性模式下短暂宽限后隐藏，便于把鼠标移到弹窗上点喇叭。
function scheduleHide() {
  clearShow();
  if (!visible || cfg.stickyPopup) return;
  clearHide();
  hideTimer = setTimeout(() => {
    hideTimer = null;
    hidePopup();
  }, 150);
}

// ---------- 事件 ----------

function handleMove(x, y) {
  const info = wordAtPoint(x, y);

  if (!info) {
    // 弹窗尚在显示时（例如光标正移向小喇叭），保留 currentWord 供点击朗读；
    // 弹窗尚未显示则清除悬停状态。
    if (!visible) currentWord = null;
    scheduleHide();
    return;
  }

  const sameWord =
    currentWord &&
    currentWord.node === info.node &&
    currentWord.start === info.start &&
    currentWord.end === info.end;

  if (sameWord) {
    // 仍停留在同一个单词上，等待原定时器触发。
    return;
  }

  currentWord = { ...info };
  clearHide();

  if (visible && cfg.stickyPopup) {
    // 粘性模式：弹窗已显示，切换到新单词同样按「悬停弹出延迟」延时展示；
    // 是否朗读由 showPopup 依据是否切到不同句子决定。
    scheduleShow({ ...info });
    return;
  }

  scheduleShow({ ...info });
}

document.addEventListener(
  'mousemove',
  (event) => {
    if (!enabled) return; // 当前站点已禁用，不响应悬停。
    // 移到弹窗本体上时保持显示，不重新计算。
    if (event.target === host) {
      clearHide();
      return;
    }
    if (isEditable(event.target)) {
      currentWord = null;
      scheduleHide();
      return;
    }
    handleMove(event.clientX, event.clientY);
  },
  { capture: true, passive: true }
);

// 点击外部关闭（点击弹窗内部不触发）。
document.addEventListener(
  'mousedown',
  (event) => {
    if (!enabled || !visible) return;
    const inside = event.composedPath
      ? event.composedPath().includes(host)
      : event.target === host;
    if (inside) return;
    hidePopup();
  },
  true
);

// Esc 关闭（若尚在延迟等待中，则一并取消弹窗）。
document.addEventListener(
  'keydown',
  (event) => {
    if (!enabled) return;
    if (event.key === 'Escape') {
      clearShow();
      hidePopup();
    }
  },
  true
);

speakBtn.addEventListener('click', () => {
  if (currentWord) speakFor(currentWord);
});

closeBtn.addEventListener('click', hidePopup);

// ---------- 配置 ----------

function applyConfig(next) {
  cfg = { ...DEFAULT_OPTIONS, ...next };
}

// 当前站点是否在禁用名单中（siteDisabled 为按 hostname 的禁用列表）。
function isSiteDisabled(list) {
  return (list || []).some((h) => String(h).toLowerCase() === HOSTNAME);
}

// 启用 / 禁用当前站点。禁用时立即收起弹窗并清空悬停状态。
function setEnabled(on) {
  on = !!on;
  if (on === enabled) return;
  enabled = on;
  if (!on) hidePopup();
}

// 站点启停与选项都存在 storage.local，首次加载时一并读取。
chrome.storage.local.get({ ...DEFAULT_OPTIONS, siteDisabled: [] }, (items) => {
  applyConfig(items);
  setEnabled(!isSiteDisabled(items.siteDisabled));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  // 站点启停变化：实时切换当前页面的启用状态（弹窗里切换后立即生效）。
  if (changes.siteDisabled) {
    setEnabled(!isSiteDisabled(changes.siteDisabled.newValue));
  }

  const next = {};
  for (const key of Object.keys(DEFAULT_OPTIONS)) {
    if (changes[key]) next[key] = changes[key].newValue;
  }
  if (Object.keys(next).length) applyConfig({ ...cfg, ...next });
});
