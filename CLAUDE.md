# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 除非用户明确告知需要更新，否则不要主动修改本文件。

## 项目概述

EchoWord —— Chrome 扩展（Manifest V3）：悬停/点击英文单词弹出卡片（音标、必应词典释义、整句中文翻译），并用系统 TTS 朗读。基于 WXT 框架 + TypeScript，源码在 `src/`（entrypoints + public），构建产物流向 `dist/`。运行时无第三方依赖，只用 `chrome.*` API；有 npm 构建工具链。

## 常用命令

- 安装依赖：`npm install`（postinstall 自动跑 `wxt prepare`，生成 `.wxt/` 类型与 tsconfig）
- 开发（HMR）：`npm run dev` → 产物在 `dist/chrome-mv3-dev/`
- 构建：`npm run build` → 产物在 `dist/chrome-mv3/`
- 类型检查（改动后必做）：`npx tsc --noEmit`
- 打包发布（可选）：`npm run zip` → `dist/echoword-<版本>-chrome.zip`
- 加载/刷新：`chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」选 `dist/chrome-mv3`（开发模式选 `dist/chrome-mv3-dev`）；改完入口文件点扩展卡片的刷新按钮，再刷新页面让 content script 重新注入

## 架构（需跨文件理解的部分）

- **`src/entrypoints/content/index.ts`** — 核心。整段逻辑包在 `defineContentScript({ matches: ['<all_urls>'], runAt: 'document_idle' })` 的 `main()` 里。Shadow DOM 弹窗宿主；鼠标事件状态机（`scheduleShow`/`scheduleHide`/`showTimer`/`hideTimer`）；`wordAtPoint` 用 `caretPositionFromPoint` + 几何包围盒（`POINT_TOLERANCE=6px`）识别单词；同一文本按两种口径提取：翻译用整句 `sentenceForTranslation`（读到句末标点、不截取），朗读用片段 `sentenceForSpeak`（按 `sentenceBreak` 配置断句：comma 断到逗号 / period 断到句号，始终 30 词截取），底层的 `sentenceFromWord(info, {stopAtComma, capWords})` 参数化实现；通过 `chrome.runtime.sendMessage` 调后台。
- **`src/entrypoints/background/index.ts`** — MV3 service worker。整段包在 `defineBackground(() => {})` 里。`chrome.tts` 朗读（过滤 macOS 搞笑音/机械音）；必应词典 fetch + 离屏解析 + 双层缓存；整句翻译（谷歌免费接口 / 必应 `ttranslatev3` token 流）；消息路由。
- **`src/entrypoints/offscreen/index.html` + `main.ts`** — 离屏文档。未列名页面（不进 manifest），由 background 按需创建：`chrome.offscreen.createDocument({ url: chrome.runtime.getURL('/offscreen.html'), reasons: ['DOM_PARSER'], ... })`。MV3 SW 无 DOMParser，解析必应词典 HTML（选择器参考 Saladict）。
- `src/entrypoints/wordbook/` — 单词本页面（`index.html` + `main.ts`，新标签页打开）。展示收藏的单词：音标快照、释义快照（收藏时缓存，离线可回顾）、每条来源例句；词条和例句均可单独朗读（`speak` 消息走 TTS 管线）、可单独删除（来源删空时 background 自动删整个词条）。出处链接总是新开标签，URL 带 `?echoword_reveal=<sid>`，由内容脚本定位例句在原页面的位置并临时闪现高亮。
- **`src/entrypoints/options/`、`src/entrypoints/popup/`** — 设置页 / 工具栏弹窗。站点启停管理 UI 全在 popup（两个 tab：当前站点 / 全部网站）。「全部网站」是全局总开关，映射到 `siteMode`（开=blacklist，关=whitelist）；「当前站点」做单站开关。黑/白名单概念对用户不可见。popup 底部有「打开单词本 / 打开完整设置」两个链接按钮（垂直两行）。
- **`wxt.config.ts`** — `srcDir:'src'`、`outDir:'dist'`、`publicDir:'src/public'`，以及 manifest 自动生成的配置项（permissions、host_permissions、icons、default_locale）。

## 关键约定（不显而易见的）

- **入口包裹**：content/background 是打包型 entrypoint，副作用代码必须放进 `main()`（WXT 构建时会在 Node 环境求值入口文件）。`options`/`popup`/`offscreen`/`wordbook` 是 HTML 引用的页面脚本（`index.html` → `main.ts`），在浏览器端执行，顶层 `init()`/`onMessage.addListener` 安全。
- **TS 基线**：`tsconfig.json` 继承 `.wxt/tsconfig.json`，`strict: false`、`types: ["chrome"]`。`@types/chrome` 会把 `chrome.storage.local.get` 回调的 items 推成 `unknown`、且缺 `tts.speak` 的 `onEvent`/`enqueue` 字段——按真实形状断言/标注；DOM 引用（`getElementById`/`querySelector`）需按元素类型 cast。这是行为保真的迁移基线，可逐步收紧。
- **消息协议**：content→background 的 `type` 为 `speak` / `speakSequence` / `stop` / `lookup` / `translate` / `getVoices` / `wordbookCheck` / `wordbookAdd` / `wordbookRemove` / `wordbookGetData` / `wordbookGetSource` / `wordbookDeleteWord` / `wordbookRemoveSource`；background→offscreen 为 `parseDictHtml`。`speakSequence`（先单词后整句）在 background 里通过 TTS `onEvent` 的 `end` 事件确定单词发音结束后再延迟 `gap` 朗读整句。异步响应需在监听器里 `return true` 保活消息通道。
- **配置存 `chrome.storage.local`**：`voiceName, volume, rate, hoverDelay, autoSpeak, speakMode, sentenceBreak, stickyPopup, translator, phonetics, popupMode, siteMode, siteDisabled, siteEnabled, excludedVoices, dictCache, wordbook`。content 脚本用 `chrome.storage.onChanged` 实时应用配置。`speakMode` 由 options 页两个复选框推导（`sentenceSpeak` + `wordFirst` → word / sentence / word_sentence）；`sentenceBreak` 是「朗读整句时，如何断句」单选（comma / period，默认 period）。
- **悬停状态机规则**：光标落在同一单词（node+start+end 相同）不重置定时器；落到空白 `scheduleHide` 取消定时器；**窗口不活跃时（`!document.hasFocus()`）不响应悬停**——macOS Chrome 抑制后台窗口连续 `mousemove`，只投递一次入口事件，这正是边界词误触发的根因；光标离开文档 / 窗口失焦时清理悬停状态。改这块逻辑务必看 `docs/technical/bugfix-hover-trigger-at-window-boundary.md`。
- **弹窗样式**：Shadow DOM + 内联 `!important` 抗页面样式；宽度首次内容加载后冻结为像素（`lockPopupWidth`）。
- **词典缓存**：background 内存 + storage.local（`DICT_CACHE_MAX=300` LRU）；content 也有一份内存缓存。翻译缓存只存成功结果。
- **单词本**：存 `chrome.storage.local` 的 `wordbook` key（软上限 `WORDBOOK_MAX_ENTRIES=2000`，超限时按时间淘汰旧词条，守护 storage 10MB 配额）。background 里所有读写经一个串行队列（`runInWordbookQueue`）避免并发写冲突。数据结构是「一词一条、多句子来源」：每词条含单词 + 音标/释义快照 + `sources[]`（每条一个例句 + 翻译 + 出处页面 URL/标题 + `sid`）。content 里词条/例句/来源三态状态机（off / part / starred）驱动弹窗星标：描边=未收藏、淡金填充（part）=词条已收藏本句未收、金色填充（starred）=本句已收藏。
- **例句定位（reveal）**：单词本点击出处链接新开标签，URL 追加 `?echoword_reveal=<sid>`；content 脚本检测该参数，按 `sid` 在原页面文本节点中定位例句（全文逐文本节点拼接匹配），并临时闪现高亮（约 2 秒）。
- **英文页判定**：content 双重闸门才启用——站点启用且页面判定为英文（`enabled = siteAllowed && pageIsEnglish`）。`siteAllowed` 由站点模式（`siteMode`）决定：黑名单=不在 `siteDisabled` 即启用，白名单=在 `siteEnabled` 才启用（见 `siteAllowedFor`）。英文判定先看 `<html lang>`，缺失时抽样正文看英文字母占比（`sampleBodyIsEnglish`）。非英文页整个不响应事件。
- **必应翻译**：需要先抓 `bing.com/translator` 解析 IG/IID/token（有有效期），子域跟随重定向（大陆 `cn.bing.com`），并发共享同一次抓取。
- **开发注意**：WXT dev 模式 content script HMR 会重跑 `main()`，可能重复挂 host——开发时以整页刷新为准；生产构建不受影响。

## 文档

- docs/api.md — 谷歌/必应翻译免费接口
- docs/prds/ — 功能 PRD
- docs/technical/ — 悬停状态机、后台窗口误触修复的详细说明