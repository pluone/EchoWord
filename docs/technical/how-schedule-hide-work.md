### 光标在页面移动时最终停留到空白处是如何不展示弹窗的？

鼠标移动会触发一系列的 movemove 事件，每个事件都会触发函数 handleMove。
handleMove 就会检查出当前光标所在处的单词，并且启动一个600ms的定时器。

那这个定时器最后是如何被清除的呢？
主要代码在这里，因为最终停留到了空白处，所以单词是 null，因此会调用 scheduleHide 函数。
scheduleHide 函数会清除已启动的定时器，从而清除悬停状态。
```
  if (!info) {
    // 弹窗尚在显示时（例如光标正移向小喇叭），保留 currentWord 供点击朗读；
    // 弹窗尚未显示则清除悬停状态。
    if (!visible) currentWord = null;
    scheduleHide();
    return;
  }
```