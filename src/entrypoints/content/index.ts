export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
// EchoWord — 悬停单词即弹出小卡片并朗读（已移除原来的「选中即朗读」）。
//
// 行为：
// - 按「弹窗触发方式」（popupMode）决定如何弹出卡片（Shadow DOM）：
//   hover 悬停、click 点击（可带修饰键）、hover + 修饰键按下、或禁用。
// - 点击喇叭图标（或开启「自动播放」后弹窗出现时）通过 chrome.tts 朗读。
// - 朗读模式（speakMode）：「单词」「整句」或「先单词后整句」。
// - 开启「粘性弹窗」时，弹窗只在点击外部、点击 X 或按 Esc 后关闭；
//   否则鼠标移开单词即关闭。

const DEFAULT_OPTIONS = {
  hoverDelay: 600, // 毫秒；0 表示立即
  autoSpeak: true, // 默认「弹窗出现后自动播放发音」
  // 朗读模式：'word' 只朗读单词 | 'sentence' 只朗读整句 |
  // 'word_sentence' 先朗读单词，再朗读整句（见 speakFor）。
  speakMode: 'word',
  // 朗读整句时的断句方式：'period' 断到句号（默认）| 'comma' 断到逗号等句内停顿。
  sentenceBreak: 'period',
  stickyPopup: false,
  phonetics: 'us', // 弹窗中展示的音标：'us' 美式（默认）| 'uk' 英式
  popupMode: 'hover_click', // 弹窗触发方式，见 popupModeConfig
  siteMode: 'blacklist', // 站点启停模式：'blacklist' 黑名单 | 'whitelist' 白名单
};

// word_sentence 模式下，单词发音结束后到朗读整句之间的固定延迟（毫秒）。
const WORD_SENTENCE_GAP = 100;

// 弹窗触发模式 → 触发行为：
// - hover: 悬停显示；click: 点击显示（可带修饰键：alt / meta(command) / ctrl）；
// - key: 悬停单词后按下修饰键显示；
// - 返回 null 表示禁用（不响应任何触发）。
function popupModeConfig(mode) {
  switch (mode) {
    case 'hover':
      return { hover: true };
    case 'hover_click':
      return { hover: true, click: true };
    case 'click':
      return { click: true };
    case 'alt_click':
      return { click: true, alt: true };
    case 'command_click':
      return { click: true, meta: true };
    case 'control_click':
      return { click: true, ctrl: true };
    case 'hover_command':
      return { key: 'meta' };
    case 'hover_control':
      return { key: 'ctrl' };
    default:
      return null; // 'disable' 及未知值：不显示弹窗
  }
}

// 英文单词字符：字母、数字、撇号、连字符。
const WORD_CHAR = /[A-Za-z0-9'’\-]/;
const HAS_ALNUM = /[A-Za-z0-9]/;

// 光标吸附容差：caretPositionFromPoint 会把空白处的光标吸附到最近的文本，
// 只要光标落在单词包围盒外这个距离以内，仍视为悬停在单词上。
const POINT_TOLERANCE = 6; // px

// 三角半宽（12px 宽的一半）：clamp 边界，保证整枚三角不出弹窗底边。
const ARROW_HALF = 6; // px

// 弹窗宽度约束：弹窗必须始终比标题行（对讲按钮 + 单词 + 音标 + 关闭按钮）宽出余量。
// 标题行内容全是单行不换行，弹窗窄了就溢出卡片、挤掉关闭按钮。
const POPUP_CHROME_X = 26; // .popup 左右 padding(12*2) + 边框(1*2)：内容宽换算到总宽的开销
const TITLE_MARGIN = 8; // 弹窗比标题行额外宽出的余量
const POPUP_MAX_WIDTH = () => Math.min(window.innerWidth * 0.6, 420); // 与 CSS max-width: min(60vw, 420px) 对齐

let cfg = { ...DEFAULT_OPTIONS };
let currentWord = null; // { word, node, start, end }
let activeSentence = null; // 当前弹窗对应的句子，用于丢弃过期的整句翻译
let showTimer = null;
let hideTimer = null;
let visible = false;
let widthLocked = false; // 本次弹窗的宽度是否已确定（确定后冻结，内容加载不再改变宽度）
let enabled = false; // 当前站点是否启用，随站点开关实时更新
const HOSTNAME = (location.hostname || '').toLowerCase();

// ---------- 弹窗宿主与 Shadow DOM ----------

const host = document.createElement('div');
host.setAttribute('data-echoword', '');
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
// 收藏星标：同一路径，未收藏时 stroke 描边（outline）、已收藏时 fill 填充（fill），
// 由 renderSaveState 按状态切换 fill / stroke 属性。
const STAR_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9-5.3-2.9-5.3 2.9 1.1-5.9-4.3-4.1 5.9-.8z"/></svg>';

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
    /* 宽度先按内容自适应（fit-content），首次内容加载后由 JS 固化为像素；
       固化的宽度始终不小于标题行（见 ensurePopupWidth），此后正文继续加载只在
       纵向扩展，不再改变宽度。 */
    width: fit-content;
    max-width: min(60vw, 420px);
    box-sizing: border-box;
  }
  /* 底边的向下小尖角，指向单词盒中心（--arrow-x 由 JS 按单词位置喂入，clamp 在弹窗内）。 */
  .popup::after {
    content: '';
    position: absolute;
    left: var(--arrow-x, 50%);
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
  /* 弹窗底边外的 6px 全宽透明接驳带（与尖角同深）：把整条边扩成可悬停带，
     命中后经 shadow 重定向为 host → clearHide，途中不落页面/其它单词上。 */
  .catch {
    position: absolute;
    left: 0;
    right: 0;
    bottom: -6px;
    height: 6px;
  }
  .popup.below .catch {
    bottom: auto;
    top: -6px;
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
    flex: 1 1 auto;
    /* 单词可给音标/按钮让位：弹窗已到最大宽度、标题行仍放不下时，单词截断成省略号不外溢。 */
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .phons {
    color: #333;
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
    margin-left: auto; /* 音标靠右 */
    flex: none; /* 音标不被压缩，放不下的宽度由单词省略号承担 */
  }
  .phons .vowel { color: #c0392b; } /* 元音红色 */
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
  /* 收藏按钮（星）三态：
     - 描边：该单词完全未收藏；
     - 金色填充（.starred）：词条已收藏 且 当前句已收藏 —— 点击取消本句；
     - 淡金色填充（.part）：词条已收藏但当前句未收藏 —— 点击追加本句，
       既表示「这个单词已在单词本里」也提示「还能再收一句」。 */
  .btn.save.starred { color: #f5a623; }
  .btn.save.part { color: #fbc968; }
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
    font-size: 13px;
    font-style: italic;
    line-height: 1.4;
    color: #1a1a1a;
  }
  .trans[hidden] { display: none; }
  /* 底部固定栏：朗读单词 / 朗读句子两个文字按钮。 */
  .foot {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 6px;
    border-top: 1px solid rgba(0, 0, 0, 0.08);
    padding-top: 6px;
    margin-top: 2px;
  }
  .foot .fbtn {
    border: none;
    background: none;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    font: inherit;
    font-size: 13px;
    color: #1a73e8;
    white-space: nowrap;
    flex: 1 1 0; /* 两按钮平分底部一栏宽度 */
  }
  .foot .fbtn:hover { background: rgba(26, 115, 232, 0.08); }
  .foot .fbtn[hidden] { display: none; }</style>
<div class="popup">
  <div class="head">
    <button class="btn speak" type="button" title="${chrome.i18n.getMessage('speakLabel')}" aria-label="${chrome.i18n.getMessage('speakLabel')}">${SPEAKER_SVG}</button>
    <span class="word"></span>
    <span class="phons"></span>
    <button class="btn save" type="button" title="${chrome.i18n.getMessage('saveWordLabel')}" aria-label="${chrome.i18n.getMessage('saveWordLabel')}">${STAR_SVG}</button>
    <button class="btn close" type="button" title="${chrome.i18n.getMessage('closeLabel')}" aria-label="${chrome.i18n.getMessage('closeLabel')}">${CLOSE_SVG}</button>
  </div>
  <div class="body" hidden>
    <div class="defs"></div>
    <div class="trans" hidden></div>
  </div>
  <div class="foot">
    <button class="fbtn speak-word" type="button"></button>
    <button class="fbtn speak-sentence" type="button"></button>
  </div>
  <span class="catch"></span>
</div>
`;

const wordEl = shadow.querySelector<HTMLElement>('.word');
const phonsEl = shadow.querySelector<HTMLElement>('.phons');
const bodyEl = shadow.querySelector<HTMLElement>('.body');
const defsEl = shadow.querySelector<HTMLElement>('.defs');
const transEl = shadow.querySelector<HTMLElement>('.trans');
const speakBtn = shadow.querySelector<HTMLElement>('.speak');
const closeBtn = shadow.querySelector<HTMLElement>('.close');
const saveBtn = shadow.querySelector<HTMLElement>('.save');
const saveSvg = shadow.querySelector<HTMLElement>('.save svg');
const speakWordBtn = shadow.querySelector<HTMLElement>('.speak-word');
const speakSentenceBtn = shadow.querySelector<HTMLElement>('.speak-sentence');
const popupEl = shadow.querySelector<HTMLElement>('.popup');
const headEl = shadow.querySelector<HTMLElement>('.head');

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
// 从单词所在文本节点提取所在句子。句子可能跨多个文本节点
// （如 <span>Hello</span> <span>world.</span>），因此：
// 1. 以最近 block 级祖先为边界收集文本，避免跨段落拼接；
// 2. 识别常见缩写（Mr. / U.S. / e.g. 等），避免把缩写句点当句末；
// 3. 同一文本可有两种口径：翻译用整句（读到句末标点、不截取），
//    朗读用片段（stopAtComma 断到逗号等句内停顿、且 MAX_SENTENCE_WORDS 截取）。

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

// 句子片段边界：stopAtComma 为真（用于朗读）时，逗号/分号/冒号等句内停顿
// 也视作片段断点，使朗读片段更短；翻译仍用整句（stopAtComma 为假）。
function isSentenceBoundary(text, i, stopAtComma) {
  if (isSentenceEnd(text, i)) return true;
  if (stopAtComma) {
    const ch = text[i];
    return ch === ',' || ch === ';' || ch === ':' ||
      ch === '，' || ch === '；' || ch === '：';
  }
  return false;
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

// 从单词所在文本节点提取句子片段。
// stopAtComma：朗读用，读到逗号等句内停顿即断，片段更短；
// capWords：朗读用，片段超过 30 词时以当前词为中心截取（翻译不用，保留整段）。
function sentenceFromWord(info, { stopAtComma = false, capWords = true } = {}) {
  // 最近 block 级祖先即遍历边界，避免跨段落获取不相关文本。
  let block = info.node.parentElement;
  while (block && !isBlockLevel(block)) block = block.parentElement;
  if (!block) block = document.body;

  const { full, targetOffset } = blockTextAndOffset(block, info.node);

  // 目标节点不可达时，退回单词所在文本节点内的单节点提取。
  const text = targetOffset < 0 ? info.node.textContent || '' : full;
  const wordStart = targetOffset < 0 ? info.start : targetOffset + info.start;
  const wordEnd = targetOffset < 0 ? info.end : targetOffset + info.end;

  // 向前找片段起点：从当前词往前找最近一次断点。
  let s = 0;
  for (let i = wordStart - 1; i >= 0; i--) {
    if (isSentenceBoundary(text, i, stopAtComma)) {
      s = skipClosers(text, i);
      break;
    }
  }
  // 向后找片段终点：从当前词往后找下一次断点（含标点本身）。
  let e = text.length;
  for (let i = wordEnd; i < text.length; i++) {
    if (isSentenceBoundary(text, i, stopAtComma)) {
      e = skipClosers(text, i);
      break;
    }
  }

  const raw = text.slice(s, e);
  const { text: sentence, lead } = cleanSentence(raw);
  if (!sentence) return info.word;
  if (!capWords) return sentence;
  return capSentence(sentence, wordStart - s - lead, wordEnd - s - lead);
}

// 朗读用句子片段：按断句选项（sentenceBreak）断到句号或逗号，超过 30 词时截取。
// 翻译仍走 sentenceForTranslation（始终读完整整句，不受该选项影响）。
function sentenceForSpeak(info) {
  return sentenceFromWord(info, {
    stopAtComma: cfg.sentenceBreak === 'comma',
    capWords: true,
  });
}

// 翻译用整句：断到句末标点，不截取（保留完整整句）。
function sentenceForTranslation(info) {
  return sentenceFromWord(info, { stopAtComma: false, capWords: false });
}

// ---------- 朗读 ----------

function speakText(text) {
  chrome.runtime.sendMessage({ type: 'speak', text }).catch(() => { });
}

// 按朗读模式朗读单词 / 整句：
// - 'sentence'：只朗读整句；'word'：只朗读单词（默认）；
// - 'word_sentence'：先朗读单词，单词发音结束后再延迟固定间隔（WORD_SENTENCE_GAP），
//   然后朗读整句（时序在 background 的 TTS onEvent 中处理）。
function speakFor(info) {
  const mode = cfg.speakMode;
  // 朗读用片段与翻译用的整句不同（朗读断到逗号），故在朗读时单独提取。
  const sentence = sentenceForSpeak(info);

  if (mode === 'sentence') {
    if (sentence) speakText(sentence);
    return;
  }

  if (!info.word) return;
  if (mode !== 'word_sentence') {
    speakText(info.word);
    return;
  }

  chrome.runtime
    .sendMessage({
      type: 'speakSequence',
      text: info.word,
      sentence: sentence,
      gap: WORD_SENTENCE_GAP,
    })
    .catch(() => { });
}

function stopSpeaking() {
  chrome.runtime.sendMessage({ type: 'stop' }).catch(() => { });
}

// ---------- 弹窗显示 / 隐藏 ----------

function renderPopup(word) {
  wordEl.textContent = word;
  phonsEl.textContent = '';
  defsEl.textContent = '';
  transEl.textContent = '';
  transEl.hidden = true;
  bodyEl.hidden = true;
  // 底部固定栏文案（i18n，静态内容，每次重渲染时兜底填充）。
  const wordLabel = chrome.i18n.getMessage('speakWordLabel');
  const sentenceLabel = chrome.i18n.getMessage('speakSentenceLabel');
  speakWordBtn.textContent = wordLabel;
  speakWordBtn.title = wordLabel;
  speakSentenceBtn.textContent = sentenceLabel;
  speakSentenceBtn.title = sentenceLabel;
  // 每次展示重新按内容确定宽度：解除冻结，恢复 fit-content。
  widthLocked = false;
  popupEl.style.width = '';
}

// 标题行（对讲按钮 + 单词 + 音标 + 关闭按钮）全是单行不换行内容，测量其自然宽度：
// 临时让标题行按 max-content 排布（可溢出弹窗），读其内容宽后立即还原。
function titleNeedWidth() {
  const prevMinWidth = headEl.style.minWidth;
  headEl.style.minWidth = 'max-content';
  const w = headEl.getBoundingClientRect().width;
  headEl.style.minWidth = prevMinWidth;
  return w;
}

// 确定/维护弹窗宽度：弹窗必须比标题行宽出 TITLE_MARGIN 余量，标题行才不外溢、
// 关闭按钮不贴边。宽度在首次内容（音标/释义或译文）加载后确定并固化为像素；
// 之后保持冻结，仅在标题行变宽（如音标迟于译文返回）时单向扩大，
// 正文即使更宽也只纵向扩展，避免弹窗来回变宽、位置跳动。
function ensurePopupWidth() {
  const want = Math.max(popupEl.offsetWidth, titleNeedWidth() + POPUP_CHROME_X + TITLE_MARGIN);
  const clamped = Math.min(want, POPUP_MAX_WIDTH());
  if (widthLocked) {
    if (clamped <= popupEl.offsetWidth) return;
    popupEl.style.width = clamped + 'px';
    positionPopup(currentWord); // 宽度变化会改变相对单词的水平居中，需重新定位
    return;
  }
  widthLocked = true;
  popupEl.style.width = clamped + 'px';
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
    renderDict(data);
  });
}

function renderDict(data) {
  if (!data) return; // 查无结果：保持仅显示单词

  // 音标：只展示设置里选中的一种（默认美式），渲染为 /音标/，元音标红。
  const phon = cfg.phonetics === 'uk' ? data.uk : data.us;
  if (phon) {
    phonsEl.textContent = '';
    phonsEl.append(renderPhoneme(phon));
  }

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
  ensurePopupWidth();
}

// 把音标渲染为「/音标/」：元音用红色 span，辅音及重音符号保持默认颜色。
function renderPhoneme(phon) {
  // IPA 元音集合（美/英式音标常见的元音符号）。
  const VOWELS = new Set(
    "iɪeɛæaɑɒʌɔoʊuəɚɝɜɞɐɶøœyɨʉ".split('')
  );

  const frag = document.createDocumentFragment();
  frag.append('/');
  for (const ch of phon) {
    if (VOWELS.has(ch)) {
      const span = document.createElement('span');
      span.className = 'vowel';
      span.textContent = ch;
      frag.appendChild(span);
    } else {
      frag.append(ch);
    }
  }
  frag.append('/');
  return frag;
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
    renderTranslation(trans);
  });
}

function renderTranslation(trans) {
  if (!trans) return; // 翻译失败或为空：保持仅显示释义
  lastTranslation = trans; // 收藏时用作译文快照
  transEl.textContent = trans;
  transEl.hidden = false;
  updateBodyVisibility();
  ensurePopupWidth();
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

  // 尖角水平位置指向单词中心（弹窗内局部 x），钳制在弹窗底边内侧，
  // 贴边时弹窗被视口钳制偏移，仍能对准单词而非黏在弹窗正中。
  const arrowX = Math.max(ARROW_HALF, Math.min(cx - left, w - ARROW_HALF));
  popupEl.style.setProperty('--arrow-x', arrowX + 'px');

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
  // 翻译用整句：读到句末标点、不做 30 词截取；朗读用的片段与之不同，在 speakFor 里单独提取。
  const sentence = sentenceForTranslation(info);
  activeSentence = sentence;
  // 没有句子上下文（如标题、孤立单词）时隐藏朗读句子按钮。
  speakSentenceBtn.hidden = !sentenceForSpeak(info);
  // 同步收藏态所需上下文：例句用于保存、译文缓存在 renderTranslation 更新。
  savedSentence = sentence;
  lastTranslation = null;
  loadTranslation(sentence);
  loadDict(info.word);
  // 异步查询该 (word, page) 是否已收藏：查询未返回前先渲染成未收藏描边星。
  loadSaveState(info.word);
  if (!cfg.autoSpeak) return;
  // 各朗读模式在 speakFor 内处理（单词 / 整句 / 先单词后整句）。
  speakFor(info);
}

function hidePopup() {
  if (!visible) return;
  visible = false;
  setHost('display', 'none');
  currentWord = null;
  activeSentence = null;
  clearShow();
  clearHide();
  stopSpeaking();
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

function handleMove(event, x, y) {
  const info = wordAtPoint(x, y);
  const mode = popupModeConfig(cfg.popupMode);
  if (!mode) return;

  // hover_command / hover_control：悬停只负责记住单词，按下修饰键时由 keydown 显示。
  if (mode.key) {
    if (!info) {
      if (!visible) currentWord = null;
      scheduleHide();
      return;
    }
    currentWord = { ...info };
    clearHide();
    return;
  }

  // 点击类模式：悬停不触发显示，弹窗锚定在点击的单词上，鼠标移开该单词即隐藏。
  if (!mode.hover) {
    if (!info) {
      if (!visible) currentWord = null;
      scheduleHide();
      return;
    }
    const onClickedWord =
      currentWord &&
      currentWord.node === info.node &&
      currentWord.start === info.start &&
      currentWord.end === info.end;
    if (onClickedWord) clearHide();
    else scheduleHide();
    return;
  }

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
  scheduleShow({ ...info });
}

document.addEventListener(
  'mousemove',
  (event) => {
    if (!enabled) return; // 当前站点已禁用，不响应悬停。
    // 窗口未处于活跃状态（如前方有其他程序窗口）时不响应悬停：
    // Chrome 会抑制后台窗口的连续 mousemove，只在光标进入窗口那一刻投递一次，
    // 悬停时长无法可靠计时，仅凭入口事件就会在边界词上误触发。
    if (!document.hasFocus()) return;
    const mode = popupModeConfig(cfg.popupMode);
    if (!mode) return; // 弹窗禁用，不响应悬停。
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
    handleMove(event, event.clientX, event.clientY);
  },
  { capture: true, passive: true }
);

// 光标离开浏览器文档（移到前方窗口、其他程序、浏览器 UI 或屏幕外）时，
// 浏览器不再收到 mousemove：已排定的悬停定时器会继续走完计时，导致
// 光标早已移开、弹窗却仍弹出（非粘性模式下弹窗也会一直悬着）。
// 这里在移出文档时取消未触发的定时器并收起弹窗（粘性模式仍保持）。
function handleDocLeave() {
  scheduleHide();
}
document.documentElement.addEventListener('mouseleave', handleDocLeave);
document.addEventListener(
  'mouseout',
  (event) => {
    // relatedTarget 为空表示光标离开了文档。
    if (!event.relatedTarget) handleDocLeave();
  },
  { capture: true }
);

// 浏览器窗口失去活跃（例如其他程序窗口置于前方）时，后台窗口不再可靠收到
// 鼠标事件，已排定的悬停定时器可能照常触发。失去焦点时立即清理悬停状态，
// 悬停的触发侧再由上面的 document.hasFocus() 门槛兜底。
window.addEventListener('blur', scheduleHide);

// 点击触发（含带修饰键的 option/alt、command、control/ctrl 点击）。
document.addEventListener(
  'click',
  (event) => {
    if (!enabled) return;
    const mode = popupModeConfig(cfg.popupMode);
    if (!mode || !mode.click) return;
    // 点击弹窗本体（喇叭 / 关闭按钮）不触发。
    const inside = event.composedPath
      ? event.composedPath().includes(host)
      : event.target === host;
    if (inside) return;
    if (isEditable(event.target)) return;

    // 需要修饰键的模式：未按下对应键则不触发。
    if (mode.alt && !event.altKey) return;
    if (mode.meta && !event.metaKey) return;
    if (mode.ctrl && !event.ctrlKey) return;

    const info = wordAtPoint(event.clientX, event.clientY);
    if (!info) return;

    currentWord = { ...info };
    clearShow();
    clearHide();
    showPopup({ ...info });
  },
  { capture: true }
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

// Esc 关闭（若尚在延迟等待中，则一并取消弹窗）；
// hover_command / hover_control：悬停于单词上时按下修饰键打开弹窗。
document.addEventListener(
  'keydown',
  (event) => {
    if (!enabled) return;
    if (event.key === 'Escape') {
      clearShow();
      hidePopup();
      return;
    }
    const mode = popupModeConfig(cfg.popupMode);
    if (!mode || !mode.key) return;
    const pressed = mode.key === 'meta' ? event.metaKey : event.ctrlKey;
    if (!pressed) return;
    if (currentWord && !visible) {
      // 按键是故意动作，与点击一样立即弹出，不经过悬停延迟。
      clearShow();
      clearHide();
      showPopup({ ...currentWord });
    }
  },
  true
);

speakBtn.addEventListener('click', () => {
  if (currentWord) speakFor(currentWord);
});

// 底部固定栏：朗读单词 / 朗读句子，跳过 speakMode 直接按其朗读。
speakWordBtn.addEventListener('click', () => {
  if (currentWord && currentWord.word) {
    stopSpeaking();
    speakText(currentWord.word);
  }
});
speakSentenceBtn.addEventListener('click', () => {
  if (currentWord) {
    const sentence = sentenceForSpeak(currentWord);
    if (sentence) {
      stopSpeaking();
      speakText(sentence);
    }
  }
});

closeBtn.addEventListener('click', hidePopup);

// ---------- 收藏（单词本） ----------
//
// 星标按钮：收藏当前单词与所在例句（整句 + 译文 + 出处 URL）。
// - 弹窗打开时异步向 background 查询 (word, page) 是否已收藏：查询前先渲染成
//   未收藏的描边星，晚到的「已收藏」结果再翻为金色填充，不阻塞弹窗出现。
// - 点击即 toggle：未收藏 → 收藏（保存中禁点）；已收藏 → 取消该来源。
// - 保存的数据全部来自当前弹窗已缓存的内容（activeSentence / 渲染中的译文，
//   dict 快照由 background 兜底），不为保存而额外请求词典或翻译。

// 当前弹窗的例句字符串（showPopup 时与 activeSentence 同步设置）。
let savedSentence = null;
// 当前弹窗例句的最新译文（renderTranslation 时记录），保存时作为快照直接采用。
let lastTranslation = null;
// 当前弹窗星标状态：'off' 词条未收藏 | 'on' 词条与当前句都已收藏 |
// 'part' 词条已收藏但当前句未收藏（淡金）。影响星标样式与点击行为。
let savedState = 'off';
// 保存/移除进行中：期间禁点，防止连点竞争。
let savePending = false;

const STAR_FILL_OFF = 'none';
const STAR_FILL_ON = 'currentColor';

// 渲染星标：'off' 描边、'on' 金色填充、'part' 淡金填充（词条已收藏过）。
function renderSaveState(state) {
  savedState = state;
  const filled = state !== 'off';
  if (saveSvg) saveSvg.setAttribute('fill', filled ? STAR_FILL_ON : STAR_FILL_OFF);
  // 'part'（词条已收藏但本句未收）与 'on' 的 title 都说明用户点了会发生什么。
  const label = chrome.i18n.getMessage(
    state === 'on' ? 'removeWordLabel' :
    state === 'part' ? 'addSentenceLabel' : 'saveWordLabel'
  );
  saveBtn.title = label;
  saveBtn.setAttribute('aria-label', label);
  saveBtn.classList.toggle('starred', state === 'on');
  saveBtn.classList.toggle('part', state === 'part');
}

// 每次弹窗打开时同步收藏状态（异步，不阻塞渲染）。background 会区分
// 「词条已收藏」与「当前句已收藏」两个信号，映射为三态星标。
function loadSaveState(word) {
  renderSaveState('off');
  savePending = false;
  chrome.runtime
    .sendMessage({ type: 'wordbookCheck', word, url: location.href, sentence: savedSentence || '' })
    .then((res) => {
      // 弹窗已切换到别的句子时丢弃过期结果。
      if (!visible || activeSentence !== savedSentence) return;
      if (res && res.ok) {
        const state = res.saved ? 'on' : res.wordSaved ? 'part' : 'off';
        renderSaveState(state);
      }
    })
    .catch(() => { });
}

saveBtn.addEventListener('click', () => {
  if (savePending || !currentWord) return;
  const word = currentWord.word;
  const url = location.href;
  const title = document.title || '';
  const sentence = savedSentence || word; // 无句可取时退化为单词本身
  savePending = true;
  saveBtn.style.opacity = '0.5';

  // 三态围绕当前句 toggle：'on' 移除本句；'off' 新建词条；'part' 给已有词条追加本句。
  const type = savedState === 'on' ? 'wordbookRemove' : 'wordbookAdd';
  const payload: Record<string, string> = { type, word, url, sentence };
  if (savedState !== 'on') {
    payload.trans = lastTranslation || '';
    payload.title = title;
  }
  chrome.runtime
    .sendMessage(payload)
    .then((res) => {
      // 成功后落到明确状态：收藏 → 'on'，移除 → 词条里是否还有本句以外的句子
      // 由 background 返回 wordSaved，映射 'part' / 'off'。
      if (res && res.ok) {
        renderSaveState(type === 'wordbookAdd' ? 'on' : res.wordSaved ? 'part' : 'off');
      }
    })
    .catch(() => { })
    .finally(() => {
      savePending = false;
      saveBtn.style.opacity = '';
    });
});

// ---------- 例句锚点定位（reveal） ----------
//
// 从单词本点击出处链接打开原页时，URL 带 ?echoword_reveal=<来源id>：
// 内容脚本取该来源的例句文本，在页面中定位后滚动居中，并叠加 ~2s 的临时
// 闪现高亮（覆盖层放在页面 DOM 上，shadow 宿主会被弹窗尺寸裁剪）。
// 处理完成后清掉 URL 参数（replaceState 不产生历史记录）。

const REVEAL_PARAM = 'echoword_reveal';
const REVEAL_SCAN_MAX = MAX_BLOCK_TEXT * 4; // 全页扫描字符上限，防大页面卡顿
const REVEAL_FLASH_MS = 2000;

function runReveal(sid) {
  if (!sid) return;
  chrome.runtime
    .sendMessage({ type: 'wordbookGetSource', sid })
    .then((res) => {
      const sentence = res && res.ok && res.data ? res.data.sentence : null;
      const word = res && res.ok && res.data ? res.data.word : null;
      if (!sentence) return;
      // 等一次布局稳定再定位（图片/字体加载会移动文本位置）。
      const start = () => revealSentence(sentence, word);
      if (document.readyState === 'complete') setTimeout(start, 300);
      else window.addEventListener('load', () => setTimeout(start, 300), { once: true });
    })
    .catch(() => { });
}

// 按句中单词构造宽松匹配正则：词与词之间允许任意空白（跨行/跨标签差异）。
function sentenceRegex(sentence) {
  const words = sentence.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const parts = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(parts.join('\\s+'), 'i');
}

// 在页面文本中定位例句（可选：同时定位句中的目标单词）。
// 按文档顺序累积文本节点、用宽松正则找首处命中，再映射回具体节点偏移。
function findSentenceOnPage(sentence, word) {
  const re = sentenceRegex(sentence);
  if (!re) return null;
  const segs = []; // { node, start, end } 文本节点段（全文拼接的最小单元）
  let total = 0;

  const walk = (el: Element) => {
    if (total >= REVEAL_SCAN_MAX) return;
    for (const child of Array.from(el.childNodes) as (Node | Element)[]) {
      if (total >= REVEAL_SCAN_MAX) return;
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child as Text).textContent || '';
        if (text) {
          segs.push({ node: child, start: total, end: total + text.length });
          total += text.length;
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el2 = child as Element;
        const tag = el2.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue;
        const style = getComputedStyle(el2);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        walk(el2);
      }
    }
  };
  if (document.body) walk(document.body);

  const full = segs.map((s) => s.node.textContent).join('');
  // 宽松正则匹配（允许跨节点空白差异），在累积全文中找首个命中。
  re.lastIndex = 0;
  const m = re.exec(full);
  if (!m) return null;

  const sent = rangeToBoundary(segs, m.index, m.index + m[0].length);
  if (!sent) return null;

  // 目标单词：在命中片段内按归一化词形精确匹配第 1 处，同样映射回节点。
  // 单词不含内部空白，不受页/句空白差异影响；映射不到时静默跳过红高亮。
  let w = null;
  if (word) {
    const tw = String(word).toLowerCase().replace(/[’]/g, "'");
    const wRe = new RegExp(tw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const wm = wRe.exec(full.slice(m.index, m.index + m[0].length));
    if (wm) {
      const wSent = rangeToBoundary(segs, m.index + wm.index, m.index + wm.index + wm[0].length);
      if (wSent) {
        w = {
          wStartNode: wSent.startNode,
          wStartOffset: wSent.startOffset,
          wEndNode: wSent.endNode,
          wEndOffset: wSent.endOffset,
        };
      }
    }
  }

  return { ...sent, ...w };
}

// 叠加闪现高亮：按 Range 的所有 client rect 放置覆盖 div，~2s 后移除。
// 颜色用半透明 amber：浅色页衬托、深色页上也足够可见（外加 2px 描边加强）。
// red 为真时用红色系（目标单词专用高亮，与整句的 amber 区分开）。
function flashRects(rects, red) {
  const container = document.createElement('div');
  container.setAttribute('data-echoword-flash', '');
  const fill = red ? 'rgba(192,57,43,0.5)' : 'rgba(255,170,0,0.35)';
  const ring = red ? 'rgba(255,80,60,0.8)' : 'rgba(255,170,0,0.55)';
  const scrollX = window.scrollX || window.pageXOffset || 0;
  const scrollY = window.scrollY || window.pageYOffset || 0;
  for (const r of rects) {
    const box = document.createElement('div');
    box.style.cssText =
      'position:absolute;pointer-events:none;' +
      'background:' + fill + ';box-shadow:0 0 0 2px ' + ring + ';border-radius:3px;';
    box.style.left = r.left + scrollX + 'px';
    box.style.top = r.top + scrollY + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    container.appendChild(box);
  }
  container.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483645;';
  (document.body || document.documentElement).appendChild(container);
  setTimeout(() => container.remove(), REVEAL_FLASH_MS);
}

// 把「累积全文偏移区间」映射回具体的文本节点与偏移。
function rangeToBoundary(segs, lo, hi) {
  let startNode = null, startOffset = 0, endNode = null, endOffset = 0;
  for (const seg of segs) {
    if (startNode === null && lo < seg.end && seg.start < hi) {
      startNode = seg.node;
      startOffset = Math.max(0, lo - seg.start);
    }
    if (startNode !== null && hi <= seg.end && seg.start < hi) {
      endNode = seg.node;
      endOffset = Math.min(seg.node.textContent.length, hi - seg.start);
      break;
    }
  }
  if (startNode === null || endNode === null) return null;
  return { startNode, startOffset, endNode, endOffset };
}

function revealSentence(sentence, word) {
  const hit = findSentenceOnPage(sentence, word);
  if (!hit) return; // 页面内容已变化：静默降级
  try {
    const range = document.createRange();
    range.setStart(hit.startNode, hit.startOffset);
    range.setEnd(hit.endNode, hit.endOffset);
    if (!range.getClientRects().length) return;
    range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => {
      flashRects(Array.from(range.getClientRects()), false);
      // 目标单词叠加红色高亮（词边界在扫描内精确算出，见 findSentenceOnPage）。
      if (hit.wStartNode) {
        const wr = document.createRange();
        wr.setStart(hit.wStartNode, hit.wStartOffset);
        wr.setEnd(hit.wEndNode, hit.wEndOffset);
        const wRects = Array.from(wr.getClientRects()).filter((r) => r.width || r.height);
        if (wRects.length) flashRects(wRects, true);
      }
    }, 450);
  } catch (e) {
    // Range 构建失败（节点被移除等）：静默降级。
  }
}

// URL 带 reveal 参数时处理一次并清理参数（页面刷新/分享不会重复闪现）。
(function initReveal() {
  try {
    const params = new URLSearchParams(location.search);
    const sid = params.get(REVEAL_PARAM);
    if (!sid) return;
    params.delete(REVEAL_PARAM);
    const qs = params.toString();
    const url = location.pathname + (qs ? '?' + qs : '') + location.hash;
    history.replaceState(null, '', url);
    runReveal(sid);
  } catch (e) {
    // 参数解析失败不影响正常功能。
  }
})();

// ---------- 配置 ----------

function applyConfig(next) {
  const merged = { ...DEFAULT_OPTIONS, ...next };
  // 迁移：旧版用布尔 sentenceSpeak 表示「朗读整句」，映射为新的 speakMode。
  if (next.sentenceSpeak !== undefined && next.speakMode === undefined) {
    merged.speakMode = next.sentenceSpeak ? 'sentence' : 'word';
  }
  cfg = merged;
}

// 当前 hostname 是否命中某个 hostname 列表。
function isSiteIn(list) {
  return (list || []).some((h) => String(h).toLowerCase() === HOSTNAME);
}

// 结合站点模式重算站点启用信号：
// - blacklist（默认）：不在禁用列表即启用（全局开启，手动关闭个别站点）；
// - whitelist：仅在启用列表里才启用（全局关闭，手动开启个别站点）。
function siteAllowedFor(mode, siteDisabled, siteEnabled) {
  return mode === 'whitelist'
    ? isSiteIn(siteEnabled)
    : !isSiteIn(siteDisabled);
}

// lang 属性是否声明为英文（en / en-US / en-GB 等）。
function isEnglishLang(langAttr) {
  const l = (langAttr || '').trim().toLowerCase();
  return l === 'en' || l.startsWith('en-') || l.startsWith('en_');
}

// 正文采样判定页面是否英文：lang 属性缺失时才调用。遍历 body 下有限个
// 可见文本节点，累计英文字母与非空白字符的占比，高于阈值则视为英文页。
// 采样上限到点即停，避免大页面卡顿；采样为空（页面几乎无文本）时保守视为英文。
const SAMPLE_MAX_LETTERS = 2000; // 累计采样字母上限，到点即停
const SAMPLE_MAX_NODES = 800; // 访问节点上限，同上
const EN_RATIO_THRESHOLD = 0.8; // 英文字母占非空白字符的比例阈值

function sampleBodyIsEnglish() {
  const body = document.body;
  if (!body) return true;
  let letters = 0;
  let nonspace = 0;
  let visited = 0;

  const walk = (el) => {
    if (letters >= SAMPLE_MAX_LETTERS || visited >= SAMPLE_MAX_NODES) return;
    const children = el.childNodes;
    for (let i = 0; i < children.length; i++) {
      if (letters >= SAMPLE_MAX_LETTERS || visited >= SAMPLE_MAX_NODES) return;
      visited++;
      const child = children[i];
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent || '';
        for (let j = 0; j < text.length; j++) {
          const ch = text[j];
          if (!/\s/.test(ch)) {
            nonspace++;
            if (/[A-Za-z]/.test(ch)) letters++;
          }
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') {
          continue;
        }
        const style = getComputedStyle(child);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        walk(child);
      }
    }
  };

  walk(body);
  return nonspace === 0 || letters / nonspace >= EN_RATIO_THRESHOLD;
}

// 是否判定为英文网页：优先 lang 属性；缺失时正文采样兜底。
function isEnglishPage() {
  const langAttr = (document.documentElement && document.documentElement.lang) || '';
  if (langAttr.trim()) return isEnglishLang(langAttr);
  return sampleBodyIsEnglish();
}

// 站点是否启用（随站点模式与启停列表实时更新，仅此一个来源）。
let siteAllowed = false;
// 页面是否判定为英文（加载时判定一次，无需监听 DOM 变化）。
let pageIsEnglish = false;

// 合并「站点启用」与「页面是英文」两个条件，决定最终启用态。
function updateActive() {
  const on = siteAllowed && pageIsEnglish;
  if (on === enabled) return;
  enabled = on;
  if (!on) hidePopup();
}

// 站点启停与选项都存在 storage.local，首次加载时一并读取。
chrome.storage.local.get(
  { ...DEFAULT_OPTIONS, siteMode: 'blacklist', siteDisabled: [], siteEnabled: [] },
  (items) => {
    applyConfig(items);
    pageIsEnglish = isEnglishPage();
    console.log('isEnglishPage', pageIsEnglish);
    siteAllowed = siteAllowedFor(items.siteMode, items.siteDisabled, items.siteEnabled);
    updateActive();
  }
);

// 站点启用信号依赖的三个键之一变化时重算，英文判定不随它们变。
const SITE_KEYS = ['siteMode', 'siteDisabled', 'siteEnabled'];

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (SITE_KEYS.some((k) => changes[k])) {
    chrome.storage.local.get(
      { siteMode: 'blacklist', siteDisabled: [], siteEnabled: [] },
      (items) => {
        siteAllowed = siteAllowedFor(items.siteMode, items.siteDisabled, items.siteEnabled);
        updateActive();
      }
    );
  }

  const next = {};
  for (const key of Object.keys(DEFAULT_OPTIONS)) {
    if (changes[key]) next[key] = changes[key].newValue;
  }
  if (Object.keys(next).length) applyConfig({ ...cfg, ...next });
});
  },
});
