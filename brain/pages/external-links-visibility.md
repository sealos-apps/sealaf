---
id: external-links-visibility
title: "外链入口默认关闭，统一配置启用"
category: decision
status: active
created: "2026-09-22T17:51:26"
updated: "2026-09-22T17:51:27"
---

<!-- compiled_truth -->
用户要求统一控制顶部文档、社区和头像菜单商务合作、用户群入口，默认 false。

沿用站点 Setting 字符串值格式，使用公开配置 laf_external_links_enabled，仅字符串 true 启用；缺失或其他值均关闭。开启后仍遵守各 URL 非空条件。旧安装无需数据库迁移，新安装初始化为 false。不新增环境变量，不永久删除入口。

配置使用方法由 web/README.md 维护。来源：BUG-190 与本次用户明确指令；可访问性仍需在客户网络验收。


## Timeline

- time: 2026-09-22T17:51:26
  kind: decision
  summary: "Created this page: 外链入口默认关闭，统一配置启用"
  source: "BUG-190; 用户 2026-09-22 明确要求"
  affects: [external-links-visibility]

- time: 2026-09-22T17:51:27
  kind: decision
  summary: "采用现有站点配置而非删除入口，缺失值默认关闭"
  source: brain update-truth
  affects: [external-links-visibility]
