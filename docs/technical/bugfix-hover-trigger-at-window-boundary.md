### 前方窗口活跃时边界单词误触发弹窗的修复

浏览器处于后台窗口（前方有其他程序的活跃窗口）时，滑过「前方窗口与浏览器边界」上的单词
会绕过 0.6s 悬停延迟、很快弹出单词卡片。本文记录现象、根因与修复，代码改动见
`content.js`。

#### 现象

- 鼠标滑过边界上的单词 → 很快触发弹窗，看起来不受 0.6s 悬停延迟控制；
- 同一时刻，位于页面中间的单词完全不会触发；
- 弹窗弹出后即使鼠标已移开，也一直悬着不消失。

#### 根因

1. **macOS 的 Chrome 会抑制后台窗口的连续 `mousemove`**。Chromium 源码
   `content/browser/renderer_host/render_widget_host_view_mac.mm` 明确写着
   *"If this is a background window, don't handle mouse movement events"*。
   后台（非活跃）窗口只会在光标进入窗口那一刻投递**一次** `mousemove`（入口事件），
   之后的移动不再投递。

2. 原实现只监听 `mousemove`，没有任何「光标离开文档」的处理，于是：

   - **中间单词**：光标在后台浏览器内移动时收不到任何 `mousemove` → 永不触发；
   - **边界单词**：光标从前方窗口进入浏览器的瞬间，那次入口 `mousemove` 落在边界词上
     → 启动 600ms 定时器；随后光标离开（移入前方窗口）时浏览器收不到任何事件
     → 定时器不被取消 → 照常触发。弹窗弹出后也因没有后续事件而一直悬着。

#### 修复

改动全部在 `content.js`，共三处：

1. **mousemove 门槛**（content.js:786）：窗口不在活跃状态时不响应悬停。
   后台窗口的悬停时长无法可靠计时，从源头取消触发。

   ```js
   if (!document.hasFocus()) return;
   ```

2. **blur 清理**（content.js:824）：浏览器窗口失去活跃时，立即取消未触发的
   定时器、收起已显示的弹窗（例如正在读着，前方窗口被激活时）。

   ```js
   window.addEventListener('blur', scheduleHide);
   ```

3. **光标离开文档的清理**（content.js:808-819）：覆盖浏览器活跃状态下光标移出文档
   （移向前方窗口、其他程序、浏览器 UI 或屏幕外）的情况。

   ```js
   function handleDocLeave() {
     scheduleHide();
   }
   document.documentElement.addEventListener('mouseleave', handleDocLeave);
   document.addEventListener(
     'mouseout',
     (event) => {
       if (!event.relatedTarget) handleDocLeave();
     },
     { capture: true }
   );
   ```

`scheduleHide`（content.js:709）负责具体清理：先 `clearShow()` 取消未触发的 600ms
弹窗定时器；弹窗已显示且非粘性模式时再设一个 150ms 的隐藏宽限（粘性模式仍保持，
由用户点击外部 / Esc 关闭）。

#### 修复后行为

- 浏览器为前台/活跃窗口时：悬停 0.6s 正常触发，行为不变；
- 浏览器为后台窗口时：完全不响应悬停（中间词与边界词都不触发）；
- 光标离开文档、或窗口失去活跃时：取消待触发的定时器、收起已显示的弹窗。

注意事项：`document.hasFocus()` 门槛同样作用于焦点在浏览器自身 UI（如地址栏、
开发者工具）时——此时悬停也不会触发，需点击回页面内容后恢复。
