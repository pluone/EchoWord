const voiceSelect = document.getElementById('voice');
const voiceHint = document.getElementById('voiceHint');
const excludeButton = document.getElementById('exclude');
const previewButton = document.getElementById('preview');
const sampleText = document.getElementById('sampleText');
const excludedList = document.getElementById('excludedList');
const excludedHint = document.getElementById('excludedHint');
const excludedToggle = document.getElementById('excludedToggle');
const excludedBody = document.getElementById('excludedBody');
const excludedCount = document.getElementById('excludedCount');
const volumeInput = document.getElementById('volume');
const volumeValue = document.getElementById('volumeValue');
const rateInput = document.getElementById('rate');
const rateValue = document.getElementById('rateValue');
const volumeTicks = document.getElementById('volumeTicks');
const rateTicks = document.getElementById('rateTicks');
const previewText = document.getElementById('previewText');
const previewCustom = document.getElementById('previewCustom');
const hoverDelayRadios = document.querySelectorAll('input[name="hoverDelay"]');
const autoSpeakInput = document.getElementById('autoSpeak');
const sentenceSpeakInput = document.getElementById('sentenceSpeak');
const sentenceBreakRadios = document.querySelectorAll('input[name="sentenceBreak"]');
const wordFirstInput = document.getElementById('wordFirst');
const wordFirstRow = document.getElementById('wordFirstRow');
const stickyPopupInput = document.getElementById('stickyPopup');
const translatorRadios = document.querySelectorAll('input[name="translator"]');
const phoneticsRadios = document.querySelectorAll('input[name="phonetics"]');
const popupModeMac = document.getElementById('popupModeMac');
const popupModeWindows = document.getElementById('popupModeWindows');

const DEFAULTS = {
  voiceName: '',
  volume: 100,
  rate: 1,
  hoverDelay: 600,
  autoSpeak: false,
  speakMode: 'word', // 'word' 单词 | 'sentence' 整句 | 'word_sentence' 先单词后整句
  sentenceBreak: 'period', // 朗读整句断句：'period' 句号（默认）| 'comma' 逗号
  stickyPopup: false,
  translator: 'google', // 'google' | 'bing'
  phonetics: 'us', // 'us' 美式 | 'uk' 英式
  popupMode: 'hover_click', // 弹窗触发方式，见 options.html 的 Pop-up mode 分组
};

// 操作系统类型：macOS 与 Windows 可选的弹窗触发方式不同（见 popupModeMac / popupModeWindows）。
const OS = (() => {
  const p =
    (navigator.userAgentData && navigator.userAgentData.platform) ||
    navigator.platform ||
    '';
  return /mac/i.test(p) ? 'mac' : /win/i.test(p) ? 'windows' : 'other';
})();

// 试听用的样例英文（经典全字母句，便于听清各个音）。
const SAMPLE_TEXT = 'The quick brown fox jumps over the lazy dog.';

// 在滑块下方渲染刻度线与刻度值。
function renderTicks(container, min, max, step, format) {
  container.innerHTML = '';
  const count = Math.round((max - min) / step);
  for (let i = 0; i <= count; i++) {
    const v = min + i * step;

    const tick = document.createElement('span');
    tick.className = 'tick';

    const line = document.createElement('span');
    line.className = 'tick-line';

    const value = document.createElement('span');
    value.className = 'tick-value';
    value.textContent = format(v);

    tick.append(line, value);
    container.appendChild(tick);
  }
}

// 渲染朗读声音下拉框 + 已剔除声音列表。
async function refreshVoices() {
  try {
    const { voices } = await chrome.runtime.sendMessage({ type: 'getVoices' });
    const { excludedVoices, voiceName } = await chrome.storage.local.get({
      excludedVoices: [],
      voiceName: '',
    });
    const excludedSet = new Set(excludedVoices);
    const available = new Set(voices.map((v) => v.voiceName));

    // 正常下拉框：只列未剔除的声音。
    voiceSelect.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '自动（默认）';
    voiceSelect.appendChild(auto);

    for (const v of voices) {
      if (excludedSet.has(v.voiceName)) continue;
      const opt = document.createElement('option');
      opt.value = v.voiceName;
      // 远程语音需要联网才能发音，这里显式标注。
      opt.textContent = v.remote ? `${v.voiceName}（需要联网）` : v.voiceName;
      voiceSelect.appendChild(opt);
    }

    // 恢复之前的选择（若该声音仍可用）。
    voiceSelect.value = available.has(voiceName) ? voiceName : '';

    // 已剔除声音列表：每个都可恢复回正常列表。
    excludedList.innerHTML = '';
    const excludedItems = voices.filter((v) => excludedSet.has(v.voiceName));
    for (const v of excludedItems) {
      const li = document.createElement('li');
      li.className = 'excluded-item';

      const name = document.createElement('span');
      name.className = 'excluded-name';
      name.textContent = v.voiceName;

      const actions = document.createElement('div');
      actions.className = 'excluded-actions';

      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'play-btn';
      play.title = '试听';
      play.textContent = '▶';
      play.addEventListener('click', () => {
        sampleText.textContent = SAMPLE_TEXT;
        sampleText.hidden = false;
        chrome.runtime
          .sendMessage({
            type: 'speak',
            text: SAMPLE_TEXT,
            voiceName: v.voiceName, // 指定该被剔除的声音试听
          })
          .catch(() => {});
      });

      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'restore-btn';
      restore.textContent = '恢复';
      restore.addEventListener('click', () => restoreVoice(v.voiceName));

      actions.append(play, restore);
      li.append(name, actions);
      excludedList.appendChild(li);
    }
    excludedCount.textContent =
      excludedItems.length > 0 ? `(${excludedItems.length})` : '';
    excludedHint.textContent =
      excludedItems.length === 0
        ? '暂无已剔除声音。'
        : '不喜欢的语音已移到这里，点击「恢复」可放回朗读列表。';

    voiceHint.textContent =
      voices.length === 0 ? '未找到英文语音，请检查系统 TTS 设置。' : '';
  } catch (err) {
    voiceHint.textContent = '加载语音失败：' + err.message;
  }
}

// 把当前选中的声音移入已剔除名单。
async function excludeVoice(name) {
  if (!name) return;

  // 记住「下一个」声音：剔除后直接把选择移过去（到底回到第一个，自动选项除外）。
  const voiceNames = Array.from(voiceSelect.options)
    .map((o) => o.value)
    .filter(Boolean);
  const idx = voiceNames.indexOf(name);
  const nextVoice = idx !== -1 ? voiceNames[(idx + 1) % voiceNames.length] : '';

  const { excludedVoices, voiceName } = await chrome.storage.local.get({
    excludedVoices: [],
    voiceName: '',
  });
  if (!excludedVoices.includes(name)) {
    await chrome.storage.local.set({
      excludedVoices: [...excludedVoices, name],
    });
  }
  // 若剔除的正是当前选择的声音，把选择移到下一个声音；否则保持不变。
  await chrome.storage.local.set({
    voiceName: voiceName === name ? nextVoice : voiceName,
  });
  await refreshVoices();
}

// 把某个声音从已剔除名单移除，恢复到正常列表。
async function restoreVoice(name) {
  const { excludedVoices } = await chrome.storage.local.get({
    excludedVoices: [],
  });
  await chrome.storage.local.set({
    excludedVoices: excludedVoices.filter((n) => n !== name),
  });
  await refreshVoices();
}

async function loadVolumeRate() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  volumeInput.value = cfg.volume;
  volumeValue.textContent = cfg.volume + '%';
  rateInput.value = cfg.rate;
  rateValue.textContent = Number(cfg.rate).toFixed(1) + '×';
}

async function loadHoverOptions() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  // 旧版可选的立即 / 0.1 秒已移除，存储仍为这些值时回退到默认，避免单选框组无选中项。
  const delayValues = new Set(Array.from(hoverDelayRadios, (r) => r.value));
  const delay = delayValues.has(String(cfg.hoverDelay))
    ? cfg.hoverDelay
    : DEFAULTS.hoverDelay;
  if (delay !== cfg.hoverDelay) chrome.storage.local.set({ hoverDelay: delay });
  for (const radio of hoverDelayRadios) {
    radio.checked = radio.value === String(delay);
  }
  autoSpeakInput.checked = !!cfg.autoSpeak;
  // 迁移：旧版布尔 sentenceSpeak → speakMode。
  if (cfg.sentenceSpeak !== undefined && cfg.speakMode === undefined) {
    cfg.speakMode = cfg.sentenceSpeak ? 'sentence' : 'word';
  }
  sentenceSpeakInput.checked = cfg.speakMode !== 'word';
  wordFirstInput.checked = cfg.speakMode === 'word_sentence';
  for (const radio of sentenceBreakRadios) {
    radio.checked = radio.value === cfg.sentenceBreak;
  }
  syncWordFirstRow();
  stickyPopupInput.checked = !!cfg.stickyPopup;
  for (const radio of translatorRadios) {
    radio.checked = radio.value === cfg.translator;
  }
  for (const radio of phoneticsRadios) {
    radio.checked = radio.value === cfg.phonetics;
  }
  // 弹窗触发方式：只展示当前系统可用的选项，存储了本系统不存在的值则回退到默认。
  const isMac = OS === 'mac';
  popupModeMac.hidden = !isMac;
  popupModeWindows.hidden = isMac;
  const modeRadios = (isMac ? popupModeMac : popupModeWindows).querySelectorAll(
    'input[name="popupMode"]'
  );
  const valid = new Set(Array.from(modeRadios, (r) => r.value));
  const mode = valid.has(cfg.popupMode) ? cfg.popupMode : DEFAULTS.popupMode;
  if (mode !== cfg.popupMode) chrome.storage.local.set({ popupMode: mode });
  for (const radio of modeRadios) {
    radio.checked = radio.value === mode;
  }
}

excludeButton.addEventListener('click', () => {
  excludeVoice(voiceSelect.value);
});

// 折叠 / 展开已剔除声音列表（默认收起）。
excludedToggle.addEventListener('click', () => {
  const willShow = excludedBody.hidden;
  excludedBody.hidden = !willShow;
  excludedToggle.setAttribute('aria-expanded', String(willShow));
});

// 试听：展示例句，并用当前选中的声音（已通过 change 保存到 storage）朗读。
previewButton.addEventListener('click', () => {
  sampleText.textContent = SAMPLE_TEXT;
  sampleText.hidden = false;
  chrome.runtime
    .sendMessage({ type: 'speak', text: SAMPLE_TEXT })
    .catch(() => {});
});

// 自定义试听：朗读用户输入 / 粘贴的文字（用当前选中的声音）。
previewCustom.addEventListener('click', () => {
  const text = previewText.value.trim();
  if (!text) return;
  chrome.runtime.sendMessage({ type: 'speak', text }).catch(() => {});
});

voiceSelect.addEventListener('change', () => {
  chrome.storage.local.set({ voiceName: voiceSelect.value });
});

volumeInput.addEventListener('input', () => {
  const v = Number(volumeInput.value);
  volumeValue.textContent = v + '%';
  chrome.storage.local.set({ volume: v });
});

rateInput.addEventListener('input', () => {
  const v = Number(rateInput.value);
  rateValue.textContent = v.toFixed(1) + '×';
  chrome.storage.local.set({ rate: v });
});

for (const radio of hoverDelayRadios) {
  radio.addEventListener('change', () => {
    if (radio.checked) {
      chrome.storage.local.set({ hoverDelay: Number(radio.value) });
    }
  });
}

autoSpeakInput.addEventListener('change', () => {
  chrome.storage.local.set({ autoSpeak: autoSpeakInput.checked });
});

// 子选项「先朗读单词，再朗读整句」仅在「朗读整句」开启时可选，否则置灰。
function syncWordFirstRow() {
  const enabled = sentenceSpeakInput.checked;
  wordFirstRow.classList.toggle('disabled', !enabled);
  wordFirstInput.disabled = !enabled;
}

// 由两个复选框推导并保存内部 speakMode：
// 不勾「朗读整句」→ word；勾了但没勾子选项 → sentence；两个都勾 → word_sentence。
function applySpeakCheckboxes() {
  const mode = !sentenceSpeakInput.checked
    ? 'word'
    : wordFirstInput.checked
      ? 'word_sentence'
      : 'sentence';
  chrome.storage.local.set({ speakMode: mode });
}

sentenceSpeakInput.addEventListener('change', () => {
  syncWordFirstRow();
  applySpeakCheckboxes();
});

wordFirstInput.addEventListener('change', applySpeakCheckboxes);

stickyPopupInput.addEventListener('change', () => {
  chrome.storage.local.set({ stickyPopup: stickyPopupInput.checked });
});

for (const radio of translatorRadios) {
  radio.addEventListener('change', () => {
    if (radio.checked) {
      chrome.storage.local.set({ translator: radio.value });
    }
  });
}

for (const radio of phoneticsRadios) {
  radio.addEventListener('change', () => {
    if (radio.checked) {
      chrome.storage.local.set({ phonetics: radio.value });
    }
  });
}

for (const radio of sentenceBreakRadios) {
  radio.addEventListener('change', () => {
    if (radio.checked) {
      chrome.storage.local.set({ sentenceBreak: radio.value });
    }
  });
}

// 两个系统分组共用 name="popupMode"，任一被选中即保存。
for (const radio of document.querySelectorAll('input[name="popupMode"]')) {
  radio.addEventListener('change', () => {
    if (radio.checked) {
      chrome.storage.local.set({ popupMode: radio.value });
    }
  });
}

async function init() {
  renderTicks(
    volumeTicks,
    Number(volumeInput.min),
    Number(volumeInput.max),
    25,
    (v) => Math.round(v) + '%'
  );
  renderTicks(
    rateTicks,
    Number(rateInput.min),
    Number(rateInput.max),
    0.5,
    (v) => v.toFixed(1) + '×'
  );
  await refreshVoices();
  await loadVolumeRate();
  await loadHoverOptions();
}

init();
