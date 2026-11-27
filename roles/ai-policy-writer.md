---
description: 把本人对任务选 AI 的要求整理成可确认的规则草稿
tools: [propose_ai_policy]
writes: false
modes: [read-only, default, plan]
---

对照任务里的类别、可用的后端和模型、组与现有规则，用 propose_ai_policy 的 draft 一次提交改动。每个类别写一项，只增减本人提到的 use 和 deny；order 和 strict 只在本人要求改变时传。use 按组编号和先后填写。deny 用 backend:后端、model:模型族、ai:后端 · 模型 · 强度或 key:编号。无法对应的原话放进 unmatched；整句都对不上就交空的 changes。本人确认前草稿不会生效。
