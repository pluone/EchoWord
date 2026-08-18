// echo word — 离屏文档：解析必应词典返回的 HTML。
//
// MV3 service worker 没有 DOMParser，抓到的必应词典页面（clientsearch 布局）
// 由 background.js 发消息到这里，用真正的 DOMParser 解析。
// 解析逻辑参考 Saladict（ext-saladict/.../dictionaries/bing）的实现。

const HOST = 'https://cn.bing.com';

function getText(parent, selector) {
  const el = selector ? parent.querySelector(selector) : parent;
  return (el && el.textContent) || '';
}

// 从 onclick 里抠 mp3 路径（参考 Saladict getAudioFromOnclick；
// 原正则括号不平衡，此处用等价的简化写法）。
function getAudioFromOnclick(el) {
  const onclick = el.getAttribute('onclick') || '';
  const match = onclick.match(/[^\s"']+\.mp3(?:\?[^\s"']*)?/);
  return match ? new URL(match[0], HOST).href : '';
}

// 取发音音频：优先读 data-pronunciation / data-mp3link / audiomd5 属性，
// 兜底解析 onclick（例句发音常藏在 onclick 里）。与 Saladict 的 getBingAudioURL 一致。
function getBingAudioURL(parent) {
  if (!parent) return '';
  const candidates = [parent];
  candidates.push(
    ...parent.querySelectorAll(
      '[data-pronunciation], [data-mp3link], [audiomd5], [onclick]'
    )
  );
  for (const el of candidates) {
    for (const attr of ['data-pronunciation', 'data-mp3link', 'audiomd5']) {
      const link = el.getAttribute(attr);
      if (link) return new URL(link, HOST).href;
    }
    const audio = getAudioFromOnclick(el);
    if (audio) return audio;
  }
  return '';
}

// 从「美国: [heˈləʊ]」/「英国: [həˈləʊ]」里取出方括号内的音标。
function extractIPA(lang) {
  const m = lang.match(/\[([^\]]+)\]/);
  return m ? m[1].trim() : '';
}

function cleanText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// 解析必应词典页面，返回 { us, uk, usAudio, ukAudio, defs, examples }；
// 任何词条都没命中时返回 null。
// 分支顺序与 Saladict 一致：有词条 → 机器翻译 → 猜你想找 → 无结果。
function parseDictHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // 有词条：.client_def_hd_hd 是词头。
  if (doc.querySelector('.client_def_hd_hd')) {
    let us = '';
    let uk = '';
    let usAudio = '';
    let ukAudio = '';
    doc.querySelectorAll('.client_def_hd_pn_list').forEach((el) => {
      const lang = getText(el, '.client_def_hd_pn').trim();
      const ipa = extractIPA(lang);
      const audio = getBingAudioURL(el);
      if (/美|us/i.test(lang)) {
        us = ipa;
        usAudio = audio;
      } else if (/英|uk/i.test(lang)) {
        uk = ipa;
        ukAudio = audio;
      } else if (!uk) {
        // 无英/美标注（如中文词）时，音标归到英式。
        uk = ipa;
        ukAudio = audio;
      }
    });

    const defs = [];
    const container = doc.querySelector('.client_def_container');
    if (container) {
      container.querySelectorAll('.client_def_bar').forEach((el) => {
        const pos = getText(el, '.client_def_title_bar').trim();
        const meanings = getText(el, '.client_def_list')
          .trim()
          .split('；')
          .map((s) => s.trim())
          .filter(Boolean);
        if (pos || meanings.length) defs.push({ pos, defs: meanings });
      });
    }

    const examples = [];
    doc.querySelectorAll('.client_sentence_list').forEach((el) => {
      if (examples.length >= 4) return;
      const en = cleanText(getText(el, '.client_sen_en'));
      if (!en) return;
      examples.push({
        en,
        zh: cleanText(getText(el, '.client_sen_cn')),
        mp3: getBingAudioURL(el),
      });
    });

    return { us, uk, usAudio, ukAudio, defs, examples };
  }

  // 机器翻译：无词条但返回了整句翻译。
  if (doc.querySelector('.client_trans_head')) {
    const mt = cleanText(getText(doc, '.client_sen_cn'));
    if (mt) {
      return { us: '', uk: '', defs: [{ pos: '翻译', defs: [mt] }], examples: [] };
    }
  }

  // 猜你想找：拼写错误的建议词。
  if (doc.querySelector('.client_do_you_mean_title_bar')) {
    const defs = [];
    doc.querySelectorAll('.client_do_you_mean_area').forEach((area) => {
      const title = getText(area, '.client_do_you_mean_title').trim();
      const words = [];
      area.querySelectorAll('.client_do_you_mean_list').forEach((list) => {
        const word = getText(list, '.client_do_you_mean_list_word').trim();
        if (word) words.push(word);
      });
      if (title && words.length) defs.push({ pos: title, defs: words });
    });
    if (defs.length) return { us: '', uk: '', defs, examples: [] };
  }

  return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'parseDictHtml' && typeof message.html === 'string') {
    try {
      sendResponse({ data: parseDictHtml(message.html) });
    } catch (e) {
      console.error('[echo word] offscreen parse error:', e);
      sendResponse({ data: null, error: String(e) });
    }
  }
});
