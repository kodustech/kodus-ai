<p align="center">
  <img alt="koduslogo" src="https://kodus.io/wp-content/uploads/2026/06/kodus-thumb-git-scaled.png">
</p>

<p align="center">
   <a href="http://makeapullrequest.com">
      <img alt="欢迎 PRs" src="https://img.shields.io/badge/PRs-welcome-darkgreen.svg?style=shields" />
   </a>
   <a href="https://github.com/kodustech/kodus-ai" target="_blank">
      <img src="https://img.shields.io/github/stars/kodustech/kodus-ai" alt="Github Stars" />
   </a>
   <a href="./license.md">
      <img src="https://img.shields.io/badge/license-AGPLv3-red" alt="许可证" />
   </a>
</p>

---

<p align="center">
   <a href="https://kodus.io">官网</a> ·
   <a href="https://discord.gg/6WbWrRbsH7">社区</a> ·
   <a href="https://docs.kodus.io">文档</a> ·
   <a href="https://docs.kodus.io/how_to_use/en/cli/overview">CLI 文档</a> ·
   <strong><a href="https://app.kodus.io">试用 Kodus Cloud </a></strong> ·
   <strong><a href="https://docs.kodus.io/how_to_deploy/en/deploy_kodus/generic_vm">自托管指南</a></strong>
</p>

<p align="center">
   🌐
   <a href="./README.md">English</a> ·
   <a href="./README.pt-BR.md">Português (BR)</a> ·
   <a href="./README.es.md">Español</a> ·
   <a href="./README.ja.md">日本語</a> ·
   <a href="./README.zh-CN.md">简体中文</a> ·
   <a href="./README.fr.md">Français</a>
</p>

## 为什么团队选择 Kodus

- **模型无关**：使用 Claude、GPT-5、Gemini、Llama、GLM、Kimi 或任何 OpenAI 兼容的 endpoint。
- **LLM 成本零加价**：你直接向模型 provider 付费。没有隐藏的倍数加价。
- **从你的上下文中学习**：Kody 适应你的架构、标准和工作流。
- **你来制定规则**：用自然语言定义自定义 review 规则。
- **隐私与安全**：源代码不会用于训练模型，数据在传输和静态存储时均加密，并支持自托管 runners。自托管实例每天发送一次匿名 heartbeat（仅聚合计数器 — 不含代码、名称或标识符）；可通过 `KODUS_TELEMETRY_DISABLED=true` 关闭。参见[匿名遥测](https://docs.kodus.io/how_to_deploy/en/deploy_kodus/telemetry)。
- **原生 Git 工作流**：直接在 GitHub、GitLab、Bitbucket 和 Azure Repos 的 PR 中工作。
- **CLI + CI/CD 就绪**：在本地和 pipelines 中运行 review。
- **运营影响**：跟踪技术债务和交付指标，同时保持高 review 质量。

## 产品亮点

<details>
  <summary><strong>🔑 自带密钥 (BYOK)</strong></summary>
<br />
连接你自己的 provider 凭证，并选择 Kodus review 背后使用的模型：OpenAI、Anthropic、Google Gemini、Vertex AI、Novita，或任何 OpenAI 兼容的 endpoint。在你的 provider 账户下管理计费和用量，没有隐藏的 LLM 加价。

<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/byok-scaled.png" alt="Kodus BYOK 模型 provider 配置" width="900">
</p>

</details>

<br />

<details>
  <summary><strong>📈 Token 用量</strong></summary>
<br />
跟踪 AI 代码 review 中的 token 消耗，了解成本驱动因素，并随着采用规模增长保持模型支出可预测。

<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/token-usage-scaled.png" alt="Kodus token 用量 dashboard" width="900">
</p>

</details>

<br />

<details>
  <summary><strong>⚙️ Kody Rules</strong></summary>
<br />
Kody Rules 让团队用自然语言定义 review 指令，并将其应用到组织、仓库、路径或特定 review 范围。Kody 在 review PR 时将这些规则作为上下文，帮助执行架构决策、安全要求、测试实践和仓库特定约定，无需 reviewer 手动重复相同的反馈。

<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/rules-scaled.png" alt="Kody rules" width="900">
</p>
</details>
<br />
<details>
  <summary><strong>📊 Cockpit</strong></summary>
<br />
Cockpit 帮助团队衡量 Kodus review 有效性、Kody Rule 健康度、仓库健康度以及贯穿工程工作流的交付指标。

<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/cockpit-kodus-scaled.png" alt="Kodus Cockpit 展示 AI 代码 review pipeline 健康状况" width="900">
</p>

</details>

<br />

<details>
  <summary><strong>🧩 Kody Issues</strong></summary>
<br />
自动跟踪已关闭 PR 中未实现的建议，按状态、严重程度、类别和仓库进行管理，并在修复出现在未来的 PR 中时让 Kody 解决它们。
<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/issues-scaled.png" alt="Kodus Issues dashboard" width="900">
</p>

</details>

<br />
<details>
  <summary><strong>🔎 查看 Kody review 真实 PR 的过程</strong></summary>
<br />
Kody 不仅仅是总结 diff。它会结合上下文 review 代码，按严重程度标记风险，并直接在 PR 中建议具体的修复方案。

<br />
<br />

<p align="center">
  <img
    src="https://kodus.io/wp-content/uploads/2025/12/review-kody-.png"
    alt="Kody 在 PR review 中检测到关键 IDOR 安全问题"
    width="700"
  />
</p>

在这个示例中，Kody 捕获了一个关键的 IDOR 风险：当 `organizationId` 查询参数以数组形式传入时可能绕过 tenant 保护，随后它在代码合并前建议了明确的运行时校验。

</details>

## 快速开始

选择符合你使用 Kodus 方式的工作流。

<table>
  <tr>
    <td width="50%">
      <strong>试用 Kodus Cloud</strong>
      <br />
      无需管理基础设施即可开始 review PR。
      <br />
      <br />
      <a href="https://app.kodus.io/signup">创建免费账户</a>
      ·
      <a href="https://kodus.io/pricing">查看定价</a>
    </td>
    <td width="50%">
      <strong>自托管 Kodus</strong>
      <br />
      在你自己的基础设施上部署 Kodus，掌控数据、模型
      和运行时配置。
      <br />
      <br />
      <a href="https://docs.kodus.io/how_to_deploy/en/deploy_kodus/generic_vm">安装指南</a>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>使用 CLI</strong>
      <br />
      在终端中针对工作树、暂存 diff、
      分支或 commit 运行 AI 代码 review。
      <br />
      <br />
      <code>kodus review</code>
      <br />
      <code>kodus review --staged</code>
      <br />
      <code>kodus review --prompt-only</code>
      <br />
      <br />
      <a href="https://docs.kodus.io/how_to_use/en/cli/introduction">CLI 概览</a>
      ·
      <a href="https://docs.kodus.io/how_to_use/en/cli/commands">命令参考</a>
      ·
      <a href="https://docs.kodus.io/how_to_use/en/cli/ci_cd">CI/CD</a>
    </td>
    <td width="50%">
      <strong>本地贡献</strong>
      <br />
      在本地运行 Kodus monorepo，进行 API、worker、
      webhooks 服务、web 应用和本地基础设施的开发。
      <br />
      <br />
      <code>git clone https://github.com/kodustech/kodus-ai.git</code>
      <br />
      <code>cd kodus-ai</code>
      <br />
      <code>yarn setup</code>
      <br />
      <br />
      <a href="https://docs.kodus.io/how_to_deploy/en/local_quickstart/orchestrator">本地快速开始</a>
    </td>
  </tr>
</table>

## Monorepo 结构

Kodus 是一个 monorepo，包含多个应用、共享 domain 库和已发布的 package。

```txt
kodus-ai/
├── apps/
│   ├── api/          # NestJS API
│   ├── web/          # Next.js dashboard
│   ├── worker/       # review 执行与队列消费者
│   └── webhooks/     # Git provider webhook 接入
├── libs/             # 共享 NestJS domain 模块
├── packages/
│   ├── kodus-flow/   # AI agent 编排 SDK
│   └── kodus-common/ # LLM 抽象 package
└── scripts/          # 开发、deploy、benchmark 与自动化脚本
```

| 路径 | 用途 |
| --- | --- |
| `apps/api` | 主 NestJS API，用于认证、组织、团队、Kody Rules、集成、权限和代码 review 编排。 |
| `apps/web` | Kodus dashboard 的 Next.js web 应用。 |
| `apps/worker` | 后台服务，用于代码 review 执行、队列处理、建议检查、自动化任务和监控任务。 |
| `apps/webhooks` | 用于 GitHub、GitLab、Azure Repos、Bitbucket 和 Forgejo 事件的 webhook 接入服务。 |
| `libs` | Kodus 各应用共享的 NestJS domain 模块。 |
| `packages/kodus-flow` | AI agent 编排 SDK。 |
| `packages/kodus-common` | 面向模型 provider 的共享 LLM 抽象 package。 |

如需完整的安装说明，请参考[本地快速开始](https://docs.kodus.io/how_to_deploy/en/local_quickstart/orchestrator)。

## 开源版 vs. Teams vs. Enterprise

| 功能 | <img src="https://kodus.io/wp-content/uploads/2026/06/kody-community2-scaled.webp" alt="Kody Community" width="110" /><br>Community | <img src="https://kodus.io/wp-content/uploads/2026/06/kody-team-scaled.webp" alt="Kody Teams" width="110" /><br>Teams | <img src="https://kodus.io/wp-content/uploads/2026/06/kody-enterprise-scaled.webp" alt="Kody Enterprise" width="110" /><br>Enterprise |
| :--- | :---: | :---: | :---: |
| 价格 | 免费 | $10/开发者/月 或 $8/开发者/年（+ tokens/开发者） | 定制 |
| 托管方式 | 自托管 **或** 由 Kodus 托管 | 由 Kodus 托管 | 自托管 **或** 由 Kodus 托管 |
| 自带密钥 (BYOK) | ✅ | ✅ | ✅ |
| PR 用量 | 使用你自己的 API key，PR 无限制 | 使用你自己的 API key，PR 无限制 | 使用 Kodus AI Tokens API key，PR 无限制 |
| 用户 | 无限制 | 无限制 | 无限制 |
| Kody Rules | 最多 10 条 | 无限制 | 无限制 |
| 活跃插件 | 最多 3 个 | 无限制 | 无限制 |
| Kody Learnings 与 Memory | ✅ | ✅ | ✅ |
| Quality Radar issues | 无限制 | 无限制 | 无限制 |
| Kody Agents 优先队列 | ❌ | ✅ | ✅ |
| Engineering Metrics / Cockpit | ❌ | ✅ | ✅ |
| SSO | ❌ | ❌ | ✅ |
| RBAC + 审计日志 + analytics | ❌ | ❌ | ✅ |
| 合规 | ❌ | ❌ | SOC 2 |
| 支持 | Discord 社区支持 | Discord 社区 + 邮件支持 | 私密 Discord + 邮件 + 每月最多 5 小时专属 onboarding/支持 |

[对比所有方案 →](https://kodus.io/pricing)

## 资源

| 资源 | 描述 |
| --- | --- |
| [官网](https://kodus.io) | 了解更多关于 Kodus、产品能力和定价的信息。 |
| [文档](https://docs.kodus.io) | 安装指南、产品文档、CLI 用法和自托管说明。 |
| [Kodus Cloud](https://app.kodus.io) | 无需管理基础设施即可开始使用 Kodus。 |
| [自托管指南](https://docs.kodus.io/how_to_deploy/en/deploy_kodus/generic_vm) | 在你自己的环境中部署 Kodus。 |
| [CLI 文档](https://docs.kodus.io/how_to_use/en/cli/overview) | 在本地、CI/CD 中或 coding agents 内运行 AI 代码 review。 |
| [Discord 社区](https://discord.gg/6WbWrRbsH7) | 提问、获取安装帮助，与 Kodus 团队交流。 |
| [定价](https://kodus.io/pricing) | 对比 Community、Teams 和 Enterprise 版本。 |
| [预约通话](https://cal.com/gabrielmalinosqui/30min) | 与 Kodus 团队沟通安装、自托管或企业需求。 |



## 贡献

<p align="left">
  <img src="https://kodus.io/wp-content/uploads/2026/06/kody-contributing-scaled.png" alt="Kody 贡献" width="230" />
</p>

我们欢迎各种规模的贡献 🧡

修复拼写错误、改进文档、报告 bug、建议功能，或者为你认为应该存在的功能提交一个 PR。

不知道从哪里开始？提一个 issue 或加入社区。我们很乐意帮忙。
