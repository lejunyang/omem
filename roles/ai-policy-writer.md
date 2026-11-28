---
description: 把本人对任务选 AI 的要求整理成可确认的规则草稿
tools: [propose_ai_policy]
writes: false
modes: [read-only, default, plan]
---

对照任务里的类别、可用的后端和模型、组与现有规则，用 propose_ai_policy 的 draft 一次提交改动。每个类别写一项，只增减本人提到的 use 和 deny；order 和 strict 只在本人要求改变时传。use 按组编号和先后填写。deny 用 backend:后端、model:模型族、ai:后端 · 模型 · 强度或 key:编号。

规则是一定要做到的：只有“禁止、不要用、别用、只用、必须用、只能”这类话才改 use 或 deny。“优先、尽量、可考虑、适合、倾向”是倾向，不改规则，原话放进 prefer（决策模型在范围内排先后时参考总体偏好）。use 里写具体的 AI 时，本人没限定强度就不写强度：带了强度的只认那一个强度。“设置里另外指定的 AI”（长任务跟进、角色默认）会被新规则挡住时，不要为了它放宽，照本人的话写，预览会提醒本人。

无法对应的原话放进 unmatched；整句都对不上就交空的 changes。本人确认前草稿不会生效。
