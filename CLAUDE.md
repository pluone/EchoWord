# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

echo word —— Chrome 扩展（Manifest V3）：悬停/点击英文单词弹出卡片（音标、必应词典释义、整句中文翻译），并用系统 TTS 朗读。纯静态扩展，无构建、无测试、无 npm。

## 常用命令

- 语法检查（改动后必做）：`node --check content.js background.js options.js popup.js offscreen.js`
- 加载/刷新：`chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」选项目根目录；改完 JS/HTML 点扩展卡片的刷新按钮，再刷新页面让 content script 重新注入
- 打包发布（可选）：`zip -r echo-word-<version>.zip . -x "*.git*" ".claude/*" "docs/*"`

## 架构（需跨文件理解的部分）

- **content.js** — 核心。注入 Shadow DOM 弹窗宿主；鼠标事件状态机（`scheduleShow`/`scheduleHide`/`showTimer`/`hideTimer`）；`wordAtPoint` 用 `caretPositionFromPoint` + 几何包围盒（`POINT_TOLERANCE=6px`）识别单词；`sentenceFromWord` 提取整句；通过 `chrome.runtime.sendMessage` 调后台。
- **background.js** — MV3 service worker。`chrome.tts` 朗读（过滤 macOS 搞笑音/机械音）；必应词典 fetch + 离屏解析 + 双层缓存；整句翻译（谷歌免费接口 / 必应 `ttranslatev3` token 流）；消息路由。
- **offscreen.js** — 离屏文档。MV3 SW 无 DOMParser，解析必应词典 HTML（选择器参考 Saladict）。
- **options.\*** / **popup.\*** — 设置页 / 工具栏按站点启停弹窗。

## 关键约定（不显而易见的）

- **消息协议**：content→background 的 `type` 为 `speak` / `stop` / `lookup` / `translate` / `getVoices`；background→offscreen 为 `parseDictHtml`。异步响应需在监听器里 `return true` 保活消息通道。
- **配置存 `chrome.storage.local`**：`voiceName, volume, rate, hoverDelay, autoSpeak, sentenceSpeak, stickyPopup, translator, phonetics, popupMode, siteDisabled, excludedVoices, dictCache`。content 脚本用 `chrome.storage.onChanged` 实时应用配置。
- **悬停状态机规则**：光标落在同一单词（node+start+end 相同）不重置定时器；落到空白 `scheduleHide` 取消定时器；**窗口不活跃时（`!document.hasFocus()`）不响应悬停**——macOS Chrome 抑制后台窗口连续 `mousemove`，只投递一次入口事件，这正是边界词误触发的根因；光标离开文档 / 窗口失焦时清理悬停状态。改这块逻辑务必看 `docs/technical/bugfix-hover-trigger-at-window-boundary.md`。
- **弹窗样式**：Shadow DOM + 内联 `!important` 抗页面样式；宽度首次内容加载后冻结为像素（`lockPopupWidth`）。
- **词典缓存**：background 内存 + storage.local（`DICT_CACHE_MAX=300` LRU）；content 也有一份内存缓存。翻译缓存只存成功结果。
- **必应翻译**：需要先抓 `bing.com/translator` 解析 IG/IID/token（有有效期），子域跟随重定向（大陆 `cn.bing.com`），并发共享同一次抓取。

## 文档

- docs/api.md — 谷歌/必应翻译免费接口
- docs/prds/ — 功能 PRD（用户会编辑，实现前重新读取）
- docs/technical/ — 悬停状态机、后台窗口误触修复的详细说明
