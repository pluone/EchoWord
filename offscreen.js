// TTS Read Word — 离屏文档：解析必应词典返回的 HTML。
//
// MV3 service worker 没有 DOMParser，抓到的必应词典页面（clientsearch 布局）
// 由 background.js 发消息到这里，用真正的 DOMParser 解析。
// 解析逻辑参考 Saladict（ext-saladict/.../dictionaries/bing）的实现。

function getText(parent, selector) {
  const el = selector ? parent.querySelector(selector) : parent;
  return (el && el.textContent) || '';
}

// 从「美国: [heˈləʊ]」/「英国: [həˈləʊ]」里取出方括号内的音标。
function extractIPA(lang) {
  const m = lang.match(/\[([^\]]+)\]/);
  return m ? m[1].trim() : '';
}

// 解析必应词典页面，返回 { us, uk, defs }；无词条时返回 null。
function parseDictHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // 有词条：.client_def_hd_hd 是词头。
  if (doc.querySelector('.client_def_hd_hd')) {
    let us = '';
    let uk = '';
    doc.querySelectorAll('.client_def_hd_pn_list').forEach((el) => {
      const lang = getText(el, '.client_def_hd_pn').trim();
      const ipa = extractIPA(lang);
      if (/美|us/i.test(lang)) {
        us = ipa;
      } else if (/英|uk/i.test(lang)) {
        uk = ipa;
      } else if (!uk) {
        // 无英/美标注（如中文词）时，音标归到英式。
        uk = ipa;
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

    return { us, uk, defs };
  }

  return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'parseDictHtml' && typeof message.html === 'string') {
    try {
      sendResponse({ data: parseDictHtml(message.html) });
    } catch (e) {
      console.error('[TTS Read Word] offscreen parse error:', e);
      sendResponse({ data: null, error: String(e) });
    }
  }
});
