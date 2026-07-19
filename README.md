# NutriAI Nutrition Tracker

NutriAI 是一个开源的中文营养追踪 Web 应用，帮助用户记录每日饮食、饮水和身体指标，并通过可选的 AI 服务解析自然语言饮食描述。项目采用本地优先设计：不配置云服务也能使用主要记录和统计功能。

> NutriAI 提供营养记录与估算，不构成医疗诊断或治疗建议。AI 与食物数据库结果可能存在误差，如有特殊健康需求，请咨询医生或注册营养师。

## 功能

- 按早餐、午餐、晚餐和零食记录饮食
- 使用自然语言描述食物，由 AI 估算重量与营养成分
- 汇总热量、蛋白质、脂肪、碳水和膳食纤维
- 记录饮水量、自定义饮水目标
- 跟踪体重、体脂率和腰围
- 设置减脂、维持或增肌目标
- 查看历史趋势和身体变化分析
- 建立自定义食物库与常用份量
- 导入、导出和删除个人数据
- 可选 Firebase 登录与跨设备同步
- 支持 PWA、离线缓存、明暗主题和键盘操作

## 一键启动（Windows）

下载并解压项目后，双击：

```text
start-nutriai.cmd
```

启动器会自动完成以下工作：

1. 检查 NutriAI 是否已经运行。
2. 首次运行时下载项目专用的便携 Node.js 22.12.0。
3. 首次运行时安装锁定版本的依赖。
4. 启动本地服务并打开 `http://127.0.0.1:4173/`。

首次运行需要联网下载运行环境和依赖，之后可以直接启动。使用期间请保留启动器窗口；关闭窗口即可停止本地服务。便携运行环境保存在 `.runtime/`，不会修改系统 Node.js 配置。

## 开发方式运行

环境要求：

- Node.js 22.12.0 或更高版本
- pnpm 11.7.0
- Java 21（仅 Firestore 规则模拟器测试需要）

```bash
pnpm install --frozen-lockfile
pnpm dev
```

打开 `http://127.0.0.1:5173/`。不配置 Firebase 时，本地记录、统计、导入和导出仍可使用；登录与云同步会保持关闭。

## AI 服务配置

进入“个人设置”，选择支持的 AI 服务商并填写 API Key。Key 只保存在当前浏览器会话中，不进入长期缓存、导出文件或 Firebase 云同步。

当前界面支持：

- OpenAI
- DeepSeek
- MiniMax
- 智谱 AI
- 通义千问
- Moonshot

浏览器会直接向所选服务商的官方 API 发起请求，不使用公共 CORS 代理。请仅在可信设备上使用自己的 Key。

## Firebase 云同步

云同步是可选功能。启用步骤：

1. 在 Firebase Console 创建 Web 应用。
2. 启用 Email/Password Authentication。
3. 创建 Cloud Firestore 数据库。
4. 复制 `.env.example` 为 `.env`，填写 Firebase Web 配置。
5. 部署仓库中的 Firestore 安全规则。

```bash
pnpm exec firebase deploy --only firestore:rules
```

登录后，个人资料、设置、每日记录、饮水、身体记录和食物库会分别写入当前用户的 Firestore 路径。安全规则禁止匿名访问和跨用户访问。

## 测试与构建

```bash
pnpm test
pnpm build
pnpm preview
```

Firestore 权限模拟器测试：

```bash
pnpm test:rules
```

该测试需要 Java 21，验证匿名访问、跨用户访问、字段白名单和数值边界。持续集成还会执行构建、CodeQL 安全扫描和依赖更新检查。

## 项目结构

```text
├─ index.html                 页面结构
├─ src/
│  ├─ app.js                 应用逻辑与页面交互
│  ├─ data-model.js          数据模型与版本迁移
│  ├─ styles.css             界面样式与主题
│  ├─ utils/                 日期和安全工具
│  └─ validation/            营养数据校验
├─ public/                   PWA 清单、图标和离线脚本
├─ tests/                    自动化测试
├─ scripts/start-nutriai.ps1 Windows 启动逻辑
├─ firestore.rules           Firestore 权限规则
└─ start-nutriai.cmd         Windows 一键启动入口
```

## 数据与隐私

- 未登录时，数据保存在浏览器本地。
- AI API Key 和 USDA Key 只保存在当前会话。
- 密钥不会进入导出文件、长期缓存或云同步。
- 用户可分别删除本机数据、云端数据或账号及全部数据。
- 导出文件可能包含个人健康记录，请妥善保管。

详细说明见 [PRIVACY.md](PRIVACY.md)，安全问题报告方式见 [SECURITY.md](SECURITY.md)。

## 参与贡献

欢迎提交问题和改进建议。开始开发前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，提交前确保自动化测试和生产构建均通过。

## 许可证

本项目采用 [MIT License](LICENSE)。
