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
https://www.bing.com/ttranslatev3?isVertical=1&&IG=CF088859A0394FF5A3A2DB1AA40F38E0&IID=translator.5023.8
这个接口已经挂了