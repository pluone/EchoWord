import './wordbook.css';
// EchoWord — 单词本页面：复习收藏的单词。
//
// 每个词条展示单词 + 音标快照 + 释义快照（收藏时缓存的，离线可回顾），
// 词条与每条例句前各有朗读图标（发 speak 消息给 background 的 TTS 管线）。
// 点击出处链接总是新开标签，URL 带 ?echoword_reveal=<sid>，由内容脚本
// 定位例句在原页面的位置并临时闪现高亮。
// 删除：每条来源可单独移除，来源删空时词条整条删除（background 处理）。

const listEl = document.getElementById('list') as HTMLElement;
const emptyEl = document.getElementById('empty') as HTMLElement;
const countEl = document.getElementById('count') as HTMLElement;

const SPEAKER_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const CLOSE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
  '<path d="M18 6 6 18M6 6l12 12"/></svg>';

// 把 HTML 里 data-i18n 标记的文本 / 属性替换为当前语言的字符串。
// 扩展 HTML 文件不做 __MSG_ 原生替换，统一在这里用 chrome.i18n.getMessage() 填充。
function localize() {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = chrome.i18n.getMessage(el.dataset.i18n);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-aria-label]').forEach((el) => {
    el.setAttribute('aria-label', chrome.i18n.getMessage(el.dataset.i18nAriaLabel));
  });
  document.title = chrome.i18n.getMessage('wordbookTitle');
}
localize();

function speak(text) {
  chrome.runtime.sendMessage({ type: 'speak', text }).catch(() => { });
}

// 把音标渲染为「/音标/」：元音用「.vowel」红色 span，其余保持默认颜色。
// （与弹窗的 renderPhoneme 同源，去掉元音 span 之外的标注。）
function renderPhoneme(phon) {
  // IPA 元音集合（与弹窗的 renderPhoneme 同源口径）。
  const VOWELS = new Set("iɪeɛæaɑɒʌɔoʊuəɚɝɜɞɐɶøœyɨʉ".split(''));

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

// 例句文本中的目标单词标红：按宽松空白/大小写边界切词匹配，与 reveal 定位的
// 宽松策略同思路（单词在句中可能被引号/标点包围，需要词级子串匹配而不是全等）。
function renderSentence(sentence, word) {
  const frag = document.createDocumentFragment();
  if (!word) {
    frag.append(sentence);
    return frag;
  }
  // 目标单词归一化后构词法匹配：词形可能带连字符/撇号/大小写变化。
  const target = word.toLowerCase().replace(/[’]/g, "'");
  const re = new RegExp(
    '(' +
      target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    ')',
    'gi'
  );
  let last = 0;
  let m;
  while ((m = re.exec(sentence)) !== null) {
    if (m.index > last) frag.append(sentence.slice(last, m.index));
    const mark = document.createElement('b');
    mark.className = 'hit';
    mark.textContent = m[0];
    frag.appendChild(mark);
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++; // 空匹配防死循环
  }
  if (last < sentence.length) frag.append(sentence.slice(last));
  return frag;
}

// 出处链接 URL：例句所在页 URL + reveal 参数（内容脚本据此定位例句位置）。
function revealUrl(url, sid) {
  return `${url}${url.includes('?') ? '&' : '?'}echoword_reveal=${encodeURIComponent(sid)}`;
}

// 词条按"添加日期"分组的样式：日期标题行 + 该日收录的词条。
// 日期标题：本地时区的当天日期（2026/9/15 式），今天的分组标「今天」。
function dayKeyOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function formatDayLabel(ts) {
  const d = new Date(ts);
  const today = dayKeyOf(Date.now());
  if (dayKeyOf(ts) === today) return chrome.i18n.getMessage('wordbookToday');
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function render(entries) {
  listEl.textContent = '';
  emptyEl.hidden = entries.length > 0;
  countEl.textContent = entries.length
    ? chrome.i18n.getMessage('wordbookCount', [String(entries.length)])
    : '';

  // 按添加日期分组（entries 已按最近更新降序；组间按最近时间降序）。
  const groups = []; // { ts, entries[] }
  for (const entry of entries) {
    const key = dayKeyOf(entry.ts || entry.sources?.[0]?.ts || Date.now());
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.entries.push(entry);
    else groups.push({ key, ts: entry.ts || entry.sources?.[0]?.ts || Date.now(), entries: [entry] });
  }

  for (const group of groups) {
    const dayEl = document.createElement('h2');
    dayEl.className = 'wb-day';
    dayEl.textContent = formatDayLabel(group.ts);
    listEl.appendChild(dayEl);

    for (const entry of group.entries) renderEntry(entry);
  }
}

function renderEntry(entry) {
    const entryEl = document.createElement('article');
    entryEl.className = 'entry';

    // 标题行：朗读按钮、单词、音标快照、删除词条按钮。
    const head = document.createElement('div');
    head.className = 'entry-head';

    const wordSpeak = document.createElement('button');
    wordSpeak.type = 'button';
    wordSpeak.className = 'icon-btn';
    wordSpeak.title = chrome.i18n.getMessage('wordbookSpeakWordLabel');
    wordSpeak.setAttribute('aria-label', chrome.i18n.getMessage('wordbookSpeakWordLabel'));
    wordSpeak.innerHTML = SPEAKER_SVG;
    wordSpeak.addEventListener('click', () => speak(entry.word));

    const wordEl = document.createElement('span');
    wordEl.className = 'entry-word';
    wordEl.textContent = entry.word;

    // 音标快照：按用户设置（phonetics: 'us' | 'uk'）展示一种，与弹窗口径一致；
    // us/uk 快照都在收藏时保存，切换偏好无需重新查词典。
    // 元音标红、渲染样式与弹窗的 renderPhoneme 完全一致。
    const phonsEl = document.createElement('span');
    phonsEl.className = 'entry-phons';
    const preferUk = storedPhonetics === 'uk';
    const phon = preferUk ? entry.uk : entry.us;
    if (phon) {
      // 只展示一种音标，无需「美/英」前缀标注。
      phonsEl.append(renderPhoneme(phon));
    } else {
      // 偏好的音标缺失时回退到另一种（快照保存时可能只有一边有）。
      const fallback = preferUk ? entry.us : entry.uk;
      if (fallback) phonsEl.append(renderPhoneme(fallback));
    }

    const spacer = document.createElement('span');
    spacer.className = 'spacer';

    const delWord = document.createElement('button');
    delWord.type = 'button';
    delWord.className = 'icon-btn del';
    delWord.title = chrome.i18n.getMessage('wordbookDeleteWordLabel');
    delWord.setAttribute('aria-label', chrome.i18n.getMessage('wordbookDeleteWordLabel'));
    delWord.innerHTML = CLOSE_SVG;
    delWord.addEventListener('click', () => {
      chrome.runtime
        .sendMessage({ type: 'wordbookDeleteWord', wordKey: entry.wordKey })
        .catch(() => { });
    });

    head.append(wordSpeak, wordEl, spacer, phonsEl, delWord);
    entryEl.appendChild(head);

    // 释义快照：每条一行「词性 + 释义」。
    for (const d of (entry.defs || []).slice(0, 4)) {
      const line = document.createElement('div');
      line.className = 'def-line';
      const pos = document.createElement('span');
      pos.className = 'pos';
      pos.textContent = d.pos ? d.pos + ' ' : '';
      const def = document.createElement('span');
      def.textContent = (d.defs || []).join('；');
      line.append(pos, def);
      entryEl.appendChild(line);
    }

    // 来源例句：朗读按钮 + 整句（尾部带 HN 风格域名链接）+ 译文 + 删除按钮。
    for (const src of entry.sources || []) {
      const sourceEl = document.createElement('div');
      sourceEl.className = 'source';

      const sentSpeak = document.createElement('button');
      sentSpeak.type = 'button';
      sentSpeak.className = 'icon-btn';
      sentSpeak.title = chrome.i18n.getMessage('wordbookSpeakSentenceLabel');
      sentSpeak.setAttribute('aria-label', chrome.i18n.getMessage('wordbookSpeakSentenceLabel'));
      sentSpeak.innerHTML = SPEAKER_SVG;
      sentSpeak.addEventListener('click', () => speak(src.sentence));

      // 例句行：朗读按钮 + 例句（HN 风格域名链接紧随其后，行内排布）。
      const sentEl = document.createElement('span');
      sentEl.className = 'source-sentence';
      // 例句中目标单词加粗标红，方便扫读定位。
      sentEl.append(renderSentence(src.sentence, entry.word));

      // HN 风格的域名链接：点击跳原页并定位到例句位置（与原出处链接行为一致）。
      const domain = (() => {
        try {
          return new URL(src.url).hostname.replace(/^www\./, '');
        } catch {
          return src.url;
        }
      })();
      const domainEl = document.createElement('a');
      domainEl.className = 'source-domain';
      domainEl.textContent = `(${domain})`;
      domainEl.title = domain;
      domainEl.href = revealUrl(src.url, src.sid);
      domainEl.target = '_blank';
      domainEl.rel = 'noopener';

      sentEl.appendChild(domainEl);

      const sSpacer = document.createElement('span');
      sSpacer.className = 'spacer';

      const delSource = document.createElement('button');
      delSource.type = 'button';
      delSource.className = 'icon-btn del';
      delSource.title = chrome.i18n.getMessage('wordbookRemoveSourceLabel');
      delSource.setAttribute('aria-label', chrome.i18n.getMessage('wordbookRemoveSourceLabel'));
      delSource.innerHTML = CLOSE_SVG;
      delSource.addEventListener('click', () => {
        chrome.runtime
          .sendMessage({ type: 'wordbookRemoveSource', wordKey: entry.wordKey, sid: src.sid })
          .catch(() => { });
      });

      const sentRow = document.createElement('div');
      sentRow.className = 'source-row';
      sentRow.append(sentSpeak, sentEl, sSpacer, delSource);
      sourceEl.appendChild(sentRow);

      if (src.trans) {
        const transEl = document.createElement('p');
        transEl.className = 'source-trans';
        transEl.textContent = src.trans;
        sourceEl.appendChild(transEl);
      }

      entryEl.appendChild(sourceEl);
    }

    listEl.appendChild(entryEl);
}

// 用户设置：弹窗展示哪种音标（'us' 美式 | 'uk' 英式），与弹窗口径保持一致。
let storedPhonetics = 'us';

async function load() {
  const res = await chrome.runtime
    .sendMessage({ type: 'wordbookGetData' })
    .catch(() => null);
  if (res && res.ok) render(res.data || []);
}

// 设置切换（含其它窗口改动）时，音标随用户偏好实时切换渲染。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['wordbook']) load();
  if (area === 'local' && changes['phonetics']) {
    storedPhonetics = String(changes['phonetics'].newValue || 'us');
    load();
  }
});

async function init() {
  document.documentElement.lang = chrome.i18n.getMessage('@@ui_locale');
  const cfg = (await chrome.storage.local.get({ phonetics: 'us' })) as {
    phonetics?: string;
  };
  storedPhonetics = cfg.phonetics || 'us';
  await load();
}

init();
