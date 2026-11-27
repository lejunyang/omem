---
name: english-item-writing
description: 出英语练习题（选择、填空、听写、翻译）的质量要求：考点、干扰项、难度、知识点标注
---

# 出英语练习题

每题只考一个主要点，`points` 写它考的知识点，统一格式，画像按它累计：

- `word:<词原形>`：`word:bill`、`word:recommend`
- `phrase:<短语，用连字符>`：`phrase:to-go`、`phrase:take-a-look`
- `grammar:<语法点英文短名>`：`grammar:present-perfect`、`grammar:countable-nouns`、`grammar:would-like`

同一个点以后再考时写法要一致，否则画像里会变成两个点。

## 各题型

**choice（选择）**
- 中选英：题干是中文意思加一句场景（“在餐厅想要打包，服务员问你，你说：”），选项是英文。
- 英选中：题干是英文句子，问加粗词或整句的意思，选项是中文。
- 听音选意：`audio.text` 是一句英文，题干只写“听录音，选出意思”，选项是中文。
- 3–4 个选项。干扰项要像真的：同一场景里的近义说法、常见误用、字面直译，不要放一眼就能排除的。
- `answer` 是正确选项的下标（从 0 开始）；正确选项的位置要打乱，不要总在同一个位置。

**cloze（填空）**
- `text` 是完整、自然的句子，只挖一个空，写成 `___`。
- 空里的答案要基本唯一；有几种都对的写法就全部列进 `answer`（如 `check`、`bill`）。
- `prompt` 可以给中文提示或首字母，避免多种合理答案。

**dictation（听写）**
- 句子长度跟等级走：A1–A2 5–8 个词，B1–B2 8–14 个词，C1 以上可以更长、带连读。
- 用场景里真会听到的话。不要用生僻专名和数字串（听写只比对词）。
- 语速 `rate` 默认 1；初学阶段可以 0.85。

**translate（翻译）**
- 中译英练表达，英译中练理解；一句话，不要整段。
- 写 `reference` 参考译文；本人的译文意思对、自然就算对，不要求和参考一致。

## 难度

`level` 按这题对本人的难度标（CEFR）：A1 日常基础词句，A2 简单场景，B1 能应付大多数日常和工作场景，B2 较复杂的句式和地道搭配，C1 以上细微差别和书面语。标得准，画像才准。

`explanation` 写一句提交后给本人看的解释：为什么是这个答案、容易错在哪。

## 材料题

中文原件优先做 `translate`（`direction: zh-en`）。保留说话意图，换掉人名、敏感数字和具体业务细节。参考译文写对方在这个关系和语气下真的会说的话。《差旅报销制度》里“确定日期再订票”可以改成“行程定了我再订票”，译作 “I’ll book the tickets once the dates are set.” 点评点明搭配或语气，例如用 “once the dates are set” 表示时间确定后，用 “confirm the time” 容易让人以为在核对具体几点。

英文原件优先挑能迁移到别的场合的搭配，换语境做单空填空或选择。例如材料写 “Leave room for questions after the talk.”，可以改成 “Does the workshop schedule leave ___ for a short break?”（答案 room）。释义选择题也另造例句，不把原句拿来加粗一个词。每道材料题填它自己的 material（真实引用、标题、匿名中文简述），expression 写中文意思和地道英文，points 第一项用稳定的 word: 或 phrase: 标出这个表达。题目、提示和选项只放练习所需的改写。
