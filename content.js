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

let cfg = { ...DEFAULT_OPTIONS };
let currentWord = null; // { word, node, start, end, x, y }
let showTimer = null;
let hideTimer = null;
let visible = false;

// ---------- 弹窗宿主与 Shadow DOM ----------

const host = document.createElement('div');
host.setAttribute('data-echo-word', '');
// 内联样式统一加 !important，尽量抵抗页面样式对宿主的干扰。
const setHost = (prop, value) => host.style.setProperty(prop, value, 'important');
setHost('position', 'fixed');
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
    align-items: center;
    gap: 6px;
    padding: 8px 10px 8px 12px;
    background: #fff;
    color: #1a1a1a;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 15px;
    line-height: 1.2;
    max-width: 60vw;
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
  .word {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
</style>
<div class="popup">
  <span class="word"></span>
  <button class="btn speak" type="button" title="朗读" aria-label="朗读">${SPEAKER_SVG}</button>
  <button class="btn close" type="button" title="关闭" aria-label="关闭">${CLOSE_SVG}</button>
</div>
`;

const wordEl = shadow.querySelector('.word');
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
  return { word, node: pos.node, start, end };
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

function speakFor(info) {
  const text = cfg.sentenceSpeak ? sentenceFromWord(info) : info.word;
  if (!text) return;
  chrome.runtime.sendMessage({ type: 'speak', text }).catch(() => {});
}

// ---------- 弹窗显示 / 隐藏 ----------

function renderPopup(word) {
  wordEl.textContent = word;
}

// 取单词的包围盒，用于把弹窗定位到单词正上方并水平居中。
function wordRect(info) {
  try {
    const range = document.createRange();
    range.setStart(info.node, info.start);
    range.setEnd(info.node, info.end);
    const r = range.getBoundingClientRect();
    if (r && (r.width || r.height)) return r;
  } catch (e) {
    // 忽略异常，退回用光标坐标定位。
  }
  return null;
}

function positionPopup(info) {
  setHost('display', 'block');
  setHost('left', '0px');
  setHost('top', '0px');

  const rect = host.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  const pad = 8;
  const gap = 6; // 尖角与单词之间的间距

  const wr =
    wordRect(info) ||
    { left: info.x, top: info.y, width: 0, height: 0, right: info.x, bottom: info.y };
  const cx = wr.left + wr.width / 2; // 单词水平中心

  let left = cx - w / 2;
  left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));

  // 优先放在单词正上方；上方空间不足时翻转到单词下方。
  let above = true;
  let top = wr.top - h - gap;
  if (top < pad) {
    above = false;
    top = wr.bottom + gap;
  }
  top = Math.max(pad, Math.min(top, window.innerHeight - h - pad));

  popupEl.classList.toggle('below', !above);

  setHost('left', left + 'px');
  setHost('top', top + 'px');
}

function showPopup(info) {
  renderPopup(info.word);
  positionPopup(info);
  visible = true;
  if (cfg.autoSpeak) speakFor(info);
}

function hidePopup() {
  if (!visible) return;
  visible = false;
  setHost('display', 'none');
  currentWord = null;
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
    currentWord = null;
    scheduleHide();
    return;
  }

  const sameWord =
    currentWord &&
    currentWord.node === info.node &&
    currentWord.start === info.start &&
    currentWord.end === info.end;

  if (sameWord) {
    // 仍停留在同一个单词上，仅更新坐标，等待原定时器触发。
    currentWord.x = x;
    currentWord.y = y;
    return;
  }

  currentWord = { ...info, x, y };
  clearHide();

  if (visible && cfg.stickyPopup) {
    // 粘性模式：弹窗已显示，实时切换为新单词（不重复触发自动朗读）。
    renderPopup(info.word);
    positionPopup({ ...info, x, y });
    return;
  }

  scheduleShow({ ...info, x, y });
}

document.addEventListener(
  'mousemove',
  (event) => {
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
    if (!visible) return;
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

chrome.storage.local.get(DEFAULT_OPTIONS, (items) => applyConfig(items));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const next = {};
  for (const key of Object.keys(DEFAULT_OPTIONS)) {
    if (changes[key]) next[key] = changes[key].newValue;
  }
  if (Object.keys(next).length) applyConfig({ ...cfg, ...next });
});
