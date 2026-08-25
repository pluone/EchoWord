# 上线准备

> 提交 Edge Add-ons 商店时，需为清单中声明的每个权限填写理由。以下中英文文字可直接粘贴到商店后台对应字段。
> 每条理由对应的实际代码位置已标注，便于与实现互相核对。

## 权限理由（Permission Justifications）

### `tts` — 朗读

- 用途：系统 TTS 朗读单词与整句、枚举语音、停止播放
- 代码位置：`background.js`（`chrome.tts.speak` / `chrome.tts.getVoices` / `chrome.tts.stop`）
- 中文：
  > 扩展用系统自带的 TTS 引擎朗读光标所指单词及其完整句子。需要调用 `chrome.tts.speak()` 播放语音、枚举已安装语音供用户在设置中选择，并可随时停止朗读。
- 英文（提交用）：
  > This extension reads the word under the cursor and its full sentence out loud using the system's built-in text-to-speech engine. The `tts` permission is required to call `chrome.tts.speak()` for playback, list installed voices so users can pick one in the settings, and stop playback.

### `storage` — 设置与缓存持久化

- 用途：本地保存用户设置（语音、音量、语速、悬停延迟、单站开关等）；本地缓存词典查询与整句翻译结果
- 代码位置：`options.js` / `popup.js` / `background.js` / `content.js`（`chrome.storage.local`）
- 中文：
  > 将用户设置（语音、音量、语速、悬停延迟、单站开关等）存入 `chrome.storage.local`，保证重启后依然生效；同时本地缓存词典查询与翻译结果，避免重复请求。所有数据仅保存在用户本机，不上传任何地方。
- 英文（提交用）：
  > Saves the user's settings (voice, volume, reading speed, hover delay, per-site on/off switches) in `chrome.storage.local` so preferences persist across sessions. It also keeps a small local cache of dictionary lookups and translations to avoid repeated network requests. All data stays on the user's device; nothing is uploaded anywhere.

### `activeTab` — 识别当前站点

- 用途：仅在弹窗内读取当前活动标签页 URL，用于打开/关闭当前站点的扩展开关
- 代码位置：`popup.js`（`chrome.tabs.query({ active: true, lastFocusedWindow: true })`）
- 中文：
  > 工具栏弹窗需要识别用户当前浏览的网站，以便针对该站打开/关闭扩展。`activeTab` 仅在弹窗内使用——点击图标时读取当前活动标签页的 URL。不会在后台访问其他标签页或浏览历史。
- 英文（提交用）：
  > The toolbar popup needs to know which website the user is currently viewing so they can enable or disable the extension for that site. `activeTab` is used only inside the popup — reading the active tab's URL when the user clicks the icon. It grants no background access to other tabs or browsing history.

### `offscreen` — 离屏解析词典 HTML

- 用途：MV3 service worker 无 DOMParser，用离屏文档解析必应词典返回的 HTML
- 代码位置：`background.js`（`chrome.offscreen.createDocument`，reason `DOM_PARSER`）、`offscreen.js`
- 中文：
  > MV3 的 service worker 没有 DOMParser。扩展抓取必应词典页面后，需要解析返回的 HTML 提取释义和例句，因此临时创建 offscreen 文档来执行解析，解析完立即关闭。
- 英文（提交用）：
  > Manifest V3 service workers have no DOM parser. The extension fetches dictionary pages from Bing and must parse the returned HTML into definitions and examples. An offscreen document is created only when needed to run that parsing and is closed as soon as it finishes.

---

## Host Permissions 理由

### `https://*.bing.com/*` — 必应词典 + 可选必应翻译

- 用途：抓取必应词典释义；仅当设置中选择必应翻译时请求其翻译接口翻译整句
- 代码位置：`background.js`（`dictUrl` clientsearch 端点 / bing translator token 流程）、`manifest.json`
- 中文：
  > 悬停单词时，扩展从必应词典（cn.bing.com/dict）抓取英文释义并本地解析；仅当用户在设置中选择了必应作为翻译引擎时，也会请求必应翻译接口翻译整句。不涉及 cookie 或账号数据。
- 英文（提交用）：
  > The extension fetches English dictionary definitions from Bing's dictionary service (cn.bing.com/dict) when you hover a word, and parses the result locally. Bing's domain is also used — only when the user selects Bing as the translator in settings — to translate the full sentence containing the highlighted word. No cookies or account data are involved.

### `https://translate.googleapis.com/*` — 谷歌整句翻译（默认引擎）

- 用途：调用谷歌免费翻译接口翻译光标所在单词的完整句子；用户可在设置中切换为必应
- 代码位置：`background.js`（`googleTranslate`，`translate_a/single` 端点）、`manifest.json`
- 中文：
  > 为翻译光标所在单词的完整句子，扩展调用谷歌免费翻译接口（translate.googleapis.com/translate_a/single）——这是默认翻译引擎，用户可在设置中切换为必应。仅发送句子文本，无其他内容。
- 英文（提交用）：
  > To translate the full sentence containing the highlighted word, the extension calls Google's free translate endpoint (translate.googleapis.com/translate_a/single) — this is the default translator unless the user switches to Bing in settings. Only the sentence text is sent; nothing else.