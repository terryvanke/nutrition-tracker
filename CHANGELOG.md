# Changelog

## [0.2.1] - 2026-07-19

- 修复仪表盘初始化时提前访问饮水目标常量、导致全部交互失效的问题。
- 增加初始化时序回归测试，并完成主要页面、弹窗、主题、日期和空状态的真实浏览器验收。

## [0.2.0] - 2026-07-16

### Security

- 移除公共 CORS 代理和云端 API Key 存储。
- API Key 改为当前会话存储。
- 修复用户及 AI 内容的 XSS 注入风险。
- 增加严格 Content Security Policy。
- 增加逐用户 Firestore Rules 及官方模拟器测试。

### Changed

- 使用 Vite 和 ES Modules 构建。
- 云同步改为按资料、设置、日期和记录分别存储。
- 增加版本化数据迁移、导入、导出和删除能力。
- 日期按本地时区生成，AI 营养结果经过严格校验。
- 增加 CI、CodeQL 和 Dependabot。
