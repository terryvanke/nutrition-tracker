# Contributing

感谢你参与 NutriAI。

## 开发流程

1. Fork 仓库并从 `main` 创建功能分支。
2. 安装 Node.js 24、pnpm 11 和 Java 21。
3. 执行 `pnpm install --frozen-lockfile`。
4. 修改代码并补充相应测试。
5. 提交前运行：

```bash
pnpm test
pnpm test:rules
pnpm build
```

## 安全要求

- 禁止提交真实 API Key、服务账号或用户健康数据。
- 不得通过公共代理转发用户凭据。
- 用户和 AI 内容不得直接写入 `innerHTML`。
- 修改 Firestore 数据结构时必须同步更新 Rules 和 Emulator 测试。
- 新增字段必须提供数据迁移和范围校验。

## Pull Request

请保持改动聚焦，并在说明中包含目的、用户影响、测试结果和必要的迁移步骤。

