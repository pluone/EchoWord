### 谷歌翻译免费接口

#### 谷歌翻译接口
https://translate.googleapis.com/translate_a/single

这个接口既可以用来查询单词，也可以用来翻译句子。
查询单词时还会返回释义，例句等。


谷歌翻译，查询单个词时会返回翻译结果，以及释义和例句。
请求
```
https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh&hl=en-US&dt=t&dt=bd&dt=md&dt=ss&dt=ex&dj=1&source=bubble&q=predicted
```

响应中的字段
```
    "definitions": [
        {
            "pos": "adjective",
            "entry": [
                {
                    "gloss": "stated or estimated as likely to happen in the future; forecast.",
                    "definition_id": "m_en_gbus1188521.004",
                    "example": "the predicted growth in road traffic"
                }
            ],
            "base_form": "predicted",
            "pos_enum": 3
        }
    ]
```

如果传入的一段话，则返回翻译结果。

```
{
    "sentences": [
        {
            "trans": "预计特朗普总统将暂停或缩减美韩联合军演，甚至缩减驻韩美军规模。",
            "orig": "It was predicted that President Trump would suspend or scale down US-SK joint exercise, or even reduce the size of US troops in Korea.",
            "backend": 3,
            "model_specification": [
                {}
            ],
            "translation_engine_debug_info": [
                {
                    "model_tracking": {
                        "checkpoint_md5": "6ffafab0da7e640be86ac09d0d5e539c",
                        "launch_doc": "en_zh_2023q1.md"
                    }
                }
            ]
        }
    ],
    "src": "en",
    "spell": {}
}
```


#### Google翻译的TTS接口
https://translate.google.com/translate_tts?ie=UTF-8&q=It%20was%20predicted%20that%20President%20Trump%20would%20suspend%20or%20scale%20down%20US-SK%20joint%20exercise%2C%20or%20even%20reduce%20the%20size%20of%20US%20troops%20in%20Korea.&tl=en-US&client=tw-ob


### 必应翻译免费接口

必应翻译 v3 接口（`ttranslatev3`）不能直接调用，需要先从
`https://bing.com/translator` 页面抓取 IG、IID 与
`params_AbusePreventionHelper` 里的 token/key（页面会重定向到实际子域，
大陆为 `cn.bing.com`），再携带它们 POST 到
`https://bing.com/ttranslatev3?isVertical=1&IG=...&IID=...`
（表单字段：fromLang / to / text / token / key）。
token 有有效期，需定期重新抓取。完整逻辑见 background.js 的
`bingTranslate`，参考自 github.com/plainheart/bing-translate-api。

示例请求（POST `application/x-www-form-urlencoded`）：
```
fromLang=en&to=zh-Hans&text=Hello%20world&token=...&key=...&tryFetchingGenderDebiasedTranslations=true
```

响应：
```
[
  {
    "translations": [
      { "text": "你好，世界", "to": "zh-Hans" }
    ]
  }
]
```

注意：`ttranslatev3` 会拒绝非浏览器 UA 的请求，扩展里由 Chrome 自动附带。