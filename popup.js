// TTS Read Word — 工具栏弹窗：两个 tab。「当前站点」控制当前网站单独开关，
// 「全部网站」是全局总开关（默认开启时全部网站默认启用，默认关闭时全部
// 网站默认停用）。
//
// 内部用一个 siteMode 记录全局状态，配合两个站点列表实现按站点启停：
// - siteMode === 'blacklist'（默认，= 全局开启）：siteDisabled 存停用站点；
// - siteMode === 'whitelist'（= 全局关闭）：siteEnabled 存启用站点。
// content script 监听这三个键实现实时切换。具体模式名对用户不可见。

const tabButtons = document.querySelectorAll('.tab-btn');
const panels = document.querySelectorAll('.tab-panel');
const siteEl = document.getElementById('site');
const siteDesc = document.getElementById('siteDesc');
const enabledInput = document.getElementById('enabled');
const globalInput = document.getElementById('global');
const allDesc = document.getElementById('allDesc');
const hintEl = document.getElementById('hint');
const openOptionsBtn = document.getElementById('openOptions');

let host = '';

// 把 HTML 里 data-i18n 标记的文本 / 属性替换为当前语言的字符串。
// 扩展 HTML 文件不做 __MSG_ 原生替换，统一在这里用 chrome.i18n.getMessage() 填充。
function localize() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = chrome.i18n.getMessage(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    el.setAttribute('aria-label', chrome.i18n.getMessage(el.dataset.i18nAriaLabel));
  });
}
localize();

// 解析当前标签页地址：只有 http/https 页面才可能注入内容脚本。
function parseTarget(url) {
  try {
    const u = new URL(url);
    const usable = u.protocol === 'http:' || u.protocol === 'https:';
    return { host: u.hostname.toLowerCase(), usable };
  } catch {
    return { host: '', usable: false };
  }
}

async function readState() {
  const { siteMode = 'blacklist', siteDisabled = [], siteEnabled = [] } =
    await chrome.storage.local.get({
      siteMode: 'blacklist',
      siteDisabled: [],
      siteEnabled: [],
    });
  return {
    // 全局是否开启：blacklist = 开启（默认全部启用）；whitelist = 关闭。
    global: siteMode !== 'whitelist',
    siteMode,
    disabled: siteDisabled.map((h) => String(h).toLowerCase()),
    enabled: siteEnabled.map((h) => String(h).toLowerCase()),
  };
}

// 单个站点在当前全局状态下是否启用。
function siteOn(siteMode, host, disabled, enabled) {
  return siteMode === 'whitelist'
    ? enabled.includes(host)
    : !disabled.includes(host);
}

async function setGlobal(on) {
  await chrome.storage.local.set({ siteMode: on ? 'blacklist' : 'whitelist' });
}

async function setSite(siteMode, host, on) {
  const key = siteMode === 'whitelist' ? 'siteEnabled' : 'siteDisabled';
  const { [key]: list = [] } = await chrome.storage.local.get({ [key]: [] });
  const set = new Set(list.map((h) => String(h).toLowerCase()));
  if (on) set.add(host);
  else set.delete(host);
  await chrome.storage.local.set({ [key]: Array.from(set) });
}

function renderCurrent(state) {
  const on = siteOn(state.siteMode, host, state.disabled, state.enabled);
  if (enabledInput.checked !== on) enabledInput.checked = on;
  siteDesc.textContent = on
    ? chrome.i18n.getMessage('siteEnabledDesc')
    : chrome.i18n.getMessage('siteDisabledDesc');
}

function renderGlobal(state) {
  if (globalInput.checked !== state.global) globalInput.checked = state.global;
  allDesc.textContent = state.global
    ? chrome.i18n.getMessage('allEnabledDesc')
    : chrome.i18n.getMessage('allDisabledDesc');
}

async function renderAll() {
  const state = await readState();
  renderCurrent(state);
  renderGlobal(state);
}

// 站点相关三键任一变化即重读并重绘（含其它 popup 打开时改动的同步）。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (['siteMode', 'siteDisabled', 'siteEnabled'].some((k) => changes[k])) {
    renderAll();
  }
});

for (const btn of tabButtons) {
  btn.addEventListener('click', () => {
    for (const b of tabButtons) b.setAttribute('aria-selected', String(b === btn));
    for (const p of panels) p.hidden = !(p.dataset.panel === btn.dataset.tab);
  });
}

enabledInput.addEventListener('change', async () => {
  const { siteMode = 'blacklist' } = await chrome.storage.local.get({ siteMode: 'blacklist' });
  await setSite(siteMode, host, enabledInput.checked);
});

globalInput.addEventListener('change', () => setGlobal(globalInput.checked));

openOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

async function init() {
  document.documentElement.lang = chrome.i18n.getMessage('@@ui_locale');
  // activeTab 权限：用户点击图标打开弹窗时，可以读到当前活动标签页的 URL。
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const parsed = parseTarget(tab?.url || '');
  host = parsed.host;
  siteEl.textContent = host || chrome.i18n.getMessage('currentPage');

  if (!parsed.usable) {
    // chrome://、扩展页等无法注入脚本的页面：开关置灰并提示。
    siteEl.textContent = host || chrome.i18n.getMessage('currentPage');
    enabledInput.disabled = true;
    globalInput.disabled = true;
    hintEl.hidden = false;
    hintEl.textContent = chrome.i18n.getMessage('noInjectHint');
    return;
  }

  await renderAll();
}

init();
