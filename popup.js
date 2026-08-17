// echo word — 工具栏弹窗：显示当前站点并支持按站点启用 / 禁用。
//
// 启停状态存在 chrome.storage.local 的 siteDisabled 数组里（禁用站点的
// hostname 列表），默认全部启用。content script 监听该数组实现实时切换。

const siteEl = document.getElementById('site');
const badgeEl = document.getElementById('badge');
const enabledInput = document.getElementById('enabled');
const hintEl = document.getElementById('hint');
const openOptionsBtn = document.getElementById('openOptions');

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

function renderState() {
  const on = enabledInput.checked;
  badgeEl.textContent = on ? '已启用' : '已停用';
  badgeEl.classList.toggle('off', !on);
}

async function init() {
  // activeTab 权限：用户点击图标打开弹窗时，可以读到当前活动标签页的 URL。
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const { host, usable } = parseTarget(tab?.url || '');

  if (!usable) {
    // chrome://、扩展页等无法注入脚本的页面：开关置灰并提示。
    siteEl.textContent = host || '当前页面';
    badgeEl.textContent = '不可用';
    badgeEl.classList.add('off');
    enabledInput.disabled = true;
    hintEl.hidden = false;
    hintEl.textContent = '此页面不支持注入脚本，无法在此启用或禁用。';
    return;
  }

  siteEl.textContent = host;

  const { siteDisabled = [] } = await chrome.storage.local.get({ siteDisabled: [] });
  const disabled = siteDisabled.map((h) => String(h).toLowerCase()).includes(host);
  enabledInput.checked = !disabled;
  renderState();

  enabledInput.addEventListener('change', async () => {
    const { siteDisabled: list = [] } = await chrome.storage.local.get({ siteDisabled: [] });
    const set = new Set(list.map((h) => String(h).toLowerCase()));
    if (enabledInput.checked) set.delete(host);
    else set.add(host);
    await chrome.storage.local.set({ siteDisabled: Array.from(set) });
    renderState();
  });
}

openOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

init();
