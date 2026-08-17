// echo word — 后台服务：用 chrome.tts 朗读 content script 传来的文字。

const DEFAULT_LANG = 'en-US';
const DEFAULT_OPTIONS = { voiceName: '', volume: 100, rate: 1 };

function isEnglishVoice(lang) {
  const l = (lang || '').toLowerCase();
  return l === 'en' || l.startsWith('en-') || l.startsWith('en_');
}

// macOS 内置的「搞怪」声音，不适合英文阅读，从列表中剔除。
const NOVELTY_VOICE_NAMES = new Set([
  'Albert',
  'Bad News',
  'Bahh',
  'Bells',
  'Boing',
  'Bubbles',
  'Cellos',
  'Good News',
  'Jester',
  'Organ',
  'Superstar',
  'Trinoids',
  'Whisper',
  'Wobble',
  'Zarvox',
]);

// macOS 内置的 Eloquence 合成音，带机械音，同样不适合英文阅读，单独成表过滤。
const ELOQUENCE_VOICE_NAMES = new Set([
  'Eddy',
  'Flo',
  'Grandma',
  'Grandpa',
  'Reed',
  'Rocko',
  'Sandy',
  'Shelley',
]);

// 获取所有英文语音（本地在前、远程在后，各自按名称排序）。
function getEnglishVoices() {
  return new Promise((resolve) => {
    chrome.tts.getVoices((voices) => {
      const enVoices = (voices || [])
        .filter((v) => isEnglishVoice(v.lang))
        .filter((v) => !NOVELTY_VOICE_NAMES.has(v.voiceName))
        .filter((v) => !ELOQUENCE_VOICE_NAMES.has(v.voiceName))
        .map((v) => ({
          voiceName: v.voiceName,
          lang: v.lang,
          remote: !!v.remote,
        }))
        .sort((a, b) => {
          if (a.remote !== b.remote) return a.remote ? 1 : -1;
          return (a.voiceName || '').localeCompare(b.voiceName || '');
        });
      resolve(enVoices);
    });
  });
}

// 朗读：应用用户配置的语音 / 音量 / 速度。
// voiceNameOverride 存在时优先使用它（如试听某个指定的声音）。
function speakText(text, voiceNameOverride) {
  chrome.storage.local.get(DEFAULT_OPTIONS, (cfg) => {
    const options = {
      lang: DEFAULT_LANG,
      enqueue: false,
      // chrome.tts 的 volume 上限为 1.0，故把 0–200% 钳制到 0–100%。
      volume: Math.min(Math.max(cfg.volume, 0), 100) / 100,
      rate: cfg.rate,
    };
    const voiceName = voiceNameOverride || cfg.voiceName;
    if (voiceName) options.voiceName = voiceName;
    chrome.tts.speak(text, options);
  });
}

// 调试：打印可用英文语音，并推断默认英文语音。
function debugVoices() {
  getEnglishVoices().then((enVoices) => {
    if (!enVoices.length) {
      console.log('[echo word] 未找到英文语音，请检查系统是否安装了英文 TTS 语音。');
      return;
    }
    const defaultVoice = enVoices.find((v) => !v.remote) || enVoices[0];
    console.log(`[echo word] 英文(en)语音共 ${enVoices.length} 个：`);
    enVoices.forEach((v, i) => {
      console.log(`  ${i}. name="${v.voiceName}" lang="${v.lang}" remote=${v.remote}`);
    });
    console.log(
      `[echo word] 默认英文(${DEFAULT_LANG})语音 → "${defaultVoice.voiceName}" (remote=${defaultVoice.remote})`
    );
  });
}

chrome.runtime.onInstalled.addListener(debugVoices);
debugVoices();

// 点击工具栏图标打开设置页。
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'speak') {
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!text) return;
    const voiceOverride =
      typeof message.voiceName === 'string' && message.voiceName
        ? message.voiceName
        : null;
    speakText(text, voiceOverride);
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === 'getVoices') {
    getEnglishVoices().then((voices) => sendResponse({ voices }));
    return true; // 异步响应，保持消息通道
  }

  if (message?.type === 'debug') {
    debugVoices();
    sendResponse({ ok: true });
    return;
  }
});
