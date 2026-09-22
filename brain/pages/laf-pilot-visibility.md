---
id: laf-pilot-visibility
title: Laf Pilot visibility requires explicit AI configuration
category: decision
status: active
created: "2026-09-22T23:27:14"
updated: "2026-09-22T23:27:31"
---

<!-- compiled_truth -->
未主动配置 AI 时，隐藏 Laf Pilot 标签和聊天面板。新安装的 ai_pilot_url 默认为空；旧安装自动填入的 https://htr4n1.laf.run/laf-gpt 同样视为未配置。前端对去除首尾空白后的值进行判断，有自定义地址才显示。

这是配置门槛，不检测自定义 AI 服务的临时故障。主动使用旧公共地址的实例也会隐藏，这是用户批准方案的已知取舍。通过代码兼容历史默认值，不修改现有数据库记录，不增加开关或迁移。


## Timeline

- time: 2026-09-22T23:27:14
  kind: decision
  summary: "Created this page: Laf Pilot visibility requires explicit AI configuration"
  source: "User-approved plan, 2026-09-22"
  affects: [laf-pilot-visibility]

- time: 2026-09-22T23:27:31
  kind: decision
  summary: "记录用户批准的默认隐藏与旧安装兼容策略"
  source: "2026-09-22 用户确认；initializer.service.ts 与 DebugPanel/index.tsx"
  affects: [laf-pilot-visibility]
