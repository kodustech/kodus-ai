<p align="center">
  <img alt="koduslogo" src="https://kodus.io/wp-content/uploads/2026/06/kodus-thumb-git-scaled.png">
</p>

<p align="center">
   <a href="http://makeapullrequest.com">
      <img alt="PRs Welcome" src="https://img.shields.io/badge/PRs-welcome-darkgreen.svg?style=shields" />
   </a>
   <a href="https://github.com/kodustech/kodus-ai" target="_blank">
      <img src="https://img.shields.io/github/stars/kodustech/kodus-ai" alt="Github Stars" />
   </a>
   <a href="./license.md">
      <img src="https://img.shields.io/badge/license-AGPLv3-red" alt="License" />
   </a>
</p>

---

<p align="center">
   <a href="https://kodus.io">Website</a> ·
   <a href="https://discord.gg/6WbWrRbsH7">Community</a> ·
   <a href="https://docs.kodus.io">Docs</a> ·
   <a href="https://docs.kodus.io/how_to_use/en/cli/overview">CLI Docs</a> ·
   <strong><a href="https://app.kodus.io">Try Kodus Cloud </a></strong> ·
   <strong><a href="https://docs.kodus.io/how_to_deploy/en/deploy_kodus/generic_vm">Self-Host Guide</a></strong>
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

## Why Teams Choose Kodus

- **Model Agnostic**: Use Claude, GPT-5, Gemini, Llama, GLM, Kimi or any OpenAI-compatible endpoint.
- **Zero Markup on LLM Costs**: You pay model providers directly. No hidden multipliers.
- **Learns from Your Context**: Kody adapts to your architecture, standards, and workflow.
- **You Set the Rules**: Define custom review rules in plain language.
- **Privacy & Security**: Source code is not used to train models, data is encrypted in transit and at rest, and self-hosted runners are supported. Self-hosted instances send one anonymous heartbeat per day (aggregated counters only — no code, names, or identifiers); opt out with `KODUS_TELEMETRY_DISABLED=true`. See [Anonymous Telemetry](https://docs.kodus.io/how_to_deploy/en/deploy_kodus/telemetry).
- **Native Git Workflow**: Works directly in PRs with GitHub, GitLab, Bitbucket, and Azure Repos.
- **CLI + CI/CD Ready**: Run reviews locally and in pipelines.
- **Operational Impact**: Track technical debt and delivery metrics while keeping review quality high.

## Product Highlights

<details>
  <summary><strong>🔑 Bring Your Own Key</strong></summary>
<br />
Connect your own provider credentials and choose the models behind Kodus reviews: OpenAI, Anthropic, Google Gemini, Vertex AI, Novita, or any OpenAI-compatible endpoint. Keep billing and usage under your own provider account, without hidden LLM markups.

<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/byok-scaled.png" alt="Kodus BYOK model provider configuration" width="900">
</p>

</details>

<br />

<details>
  <summary><strong>📈 Token Usage</strong></summary>
<br />
Track token consumption across AI code reviews, understand cost drivers, and keep model spend predictable as adoption grows.

<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/token-usage-scaled.png" alt="Kodus token usage dashboard" width="900">
</p>

</details>

<br />

<details>
  <summary><strong>⚙️ Kody Rules</strong></summary>
<br />
Kody Rules let teams define review instructions in plain language and apply them across organizations, repositories, paths, or specific review scopes. Kody uses those rules as context when reviewing pull requests, helping enforce architecture decisions, security expectations, testing practices, and repository-specific conventions without relying on reviewers to repeat the same feedback manually.

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
Cockpit helps teams measure Kodus review effectiveness, Kody Rule health, repository health, and delivery metrics across the engineering workflow.

<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/cockpit-kodus-scaled.png" alt="Kodus Cockpit showing AI code review pipeline health" width="900">
</p>

</details>

<br />

<details>
  <summary><strong>🧩 Kody Issues</strong></summary>
<br />
Automatically track unimplemented suggestions from closed pull requests, manage them by status, severity, category, and repository, and let Kody resolve them when the fix appears in a future PR.
<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/issues-scaled.png" alt="Kodus Issues dashboard" width="900">
</p>

</details>

<br />
<details>
  <summary><strong>🔎 See Kody reviewing a real pull request</strong></summary>
<br />
Kody does more than summarize diffs. It reviews code with context, flags risks by severity, and suggests concrete fixes directly in the pull request.

<br />
<br />

<p align="center">
  <img
    src="https://kodus.io/wp-content/uploads/2025/12/review-kody-.png"
    alt="Kody detecting a critical IDOR security issue in a pull request review"
    width="700"
  />
</p>

In this example, Kody catches a critical IDOR risk where an `organizationId` query parameter could bypass tenant protection when passed as an array, then suggests an explicit runtime validation before the code is merged.

</details>

## Get Started

Choose the workflow that matches how you want to use Kodus.

<table>
  <tr>
    <td width="50%">
      <strong>Try Kodus Cloud</strong>
      <br />
      Start reviewing pull requests without managing infrastructure.
      <br />
      <br />
      <a href="https://app.kodus.io/signup">Create a free account</a>
      ·
      <a href="https://kodus.io/pricing">View pricing</a>
    </td>
    <td width="50%">
      <strong>Self-host Kodus</strong>
      <br />
      Deploy Kodus on your own infrastructure with control over data, models,
      and runtime configuration.
      <br />
      <br />
      <a href="https://docs.kodus.io/how_to_deploy/en/deploy_kodus/generic_vm">Installation guide</a>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>Use the CLI</strong>
      <br />
      Run AI code reviews from your terminal against a working tree, staged diff,
      branch, or commit.
      <br />
      <br />
      <code>kodus review</code>
      <br />
      <code>kodus review --staged</code>
      <br />
      <code>kodus review --prompt-only</code>
      <br />
      <br />
      <a href="https://docs.kodus.io/how_to_use/en/cli/introduction">CLI overview</a>
      ·
      <a href="https://docs.kodus.io/how_to_use/en/cli/commands">Command reference</a>
      ·
      <a href="https://docs.kodus.io/how_to_use/en/cli/ci_cd">CI/CD</a>
    </td>
    <td width="50%">
      <strong>Contribute Locally</strong>
      <br />
      Run the Kodus monorepo locally for development across the API, worker,
      webhooks service, web app, and local infrastructure.
      <br />
      <br />
      <code>git clone https://github.com/kodustech/kodus-ai.git</code>
      <br />
      <code>cd kodus-ai</code>
      <br />
      <code>yarn setup</code>
      <br />
      <br />
      <a href="https://docs.kodus.io/how_to_deploy/en/local_quickstart/orchestrator">Local quickstart</a>
    </td>
  </tr>
</table>

## Monorepo Structure

Kodus is a monorepo with multiple applications, shared domain libraries, and published packages.

```txt
kodus-ai/
├── apps/
│   ├── api/          # NestJS API
│   ├── web/          # Next.js dashboard
│   ├── worker/       # Review execution and queue consumers
│   └── webhooks/     # Git provider webhook ingestion
├── libs/             # Shared NestJS domain modules
├── packages/
│   ├── kodus-flow/   # AI agent orchestration SDK
│   └── kodus-common/ # LLM abstraction package
└── scripts/          # Dev, deploy, benchmark, and automation scripts
```

| Path | Purpose |
| --- | --- |
| `apps/api` | Main NestJS API for authentication, organizations, teams, Kody Rules, integrations, permissions, and code review orchestration. |
| `apps/web` | Next.js web application for the Kodus dashboard. |
| `apps/worker` | Background service for code review execution, queue processing, suggestion checks, automation jobs, and monitoring tasks. |
| `apps/webhooks` | Webhook ingestion service for GitHub, GitLab, Azure Repos, Bitbucket, and Forgejo events. |
| `libs` | Shared NestJS domain modules used across Kodus applications. |
| `packages/kodus-flow` | SDK for AI agent orchestration. |
| `packages/kodus-common` | Shared LLM abstraction package for model providers. |

For full setup instructions, follow the [Local Quickstart](https://docs.kodus.io/how_to_deploy/en/local_quickstart/orchestrator).

## Open Source vs. Teams vs. Enterprise

| Feature | <img src="https://kodus.io/wp-content/uploads/2026/06/kody-community2-scaled.webp" alt="Kody Community" width="110" /><br>Community | <img src="https://kodus.io/wp-content/uploads/2026/06/kody-team-scaled.webp" alt="Kody Teams" width="110" /><br>Teams | <img src="https://kodus.io/wp-content/uploads/2026/06/kody-enterprise-scaled.webp" alt="Kody Enterprise" width="110" /><br>Enterprise |
| :--- | :---: | :---: | :---: |
| Price | Free | $10/dev monthly or $8/dev annual (+ tokens/dev) | Custom |
| Hosting | Self-hosted **or** hosted by Kodus | Hosted by Kodus | Self-hosted **or** hosted by Kodus |
| Bring Your Own Key (BYOK) | ✅ | ✅ | ✅ |
| PR usage | Unlimited PRs using your own API key | Unlimited PRs using your own API key | Unlimited PRs using Kodus AI Tokens API key |
| Users | Unlimited | Unlimited | Unlimited |
| Kody Rules | Up to 10 | Unlimited | Unlimited |
| Active plugins | Up to 3 | Unlimited | Unlimited |
| Kody Learnings and Memory | ✅ | ✅ | ✅ |
| Quality Radar issues | Unlimited | Unlimited | Unlimited |
| Priority queue for Kody Agents | ❌ | ✅ | ✅ |
| Engineering Metrics / Cockpit | ❌ | ✅ | ✅ |
| SSO | ❌ | ❌ | ✅ |
| RBAC + audit logs + analytics | ❌ | ❌ | ✅ |
| Compliance | ❌ | ❌ | SOC 2 |
| Support | Discord Community Support | Discord Community + Email Support | Private Discord + Email + up to 5h/month dedicated onboarding/support |

[Compare all plan →](https://kodus.io/pricing)

## Resources

| Resource | Description |
| --- | --- |
| [Website](https://kodus.io) | Learn more about Kodus, product capabilities, and pricing. |
| [Documentation](https://docs.kodus.io) | Setup guides, product docs, CLI usage, and self-hosting instructions. |
| [Kodus Cloud](https://app.kodus.io) | Start using Kodus without managing infrastructure. |
| [Self-Host Guide](https://docs.kodus.io/how_to_deploy/en/deploy_kodus/generic_vm) | Deploy Kodus in your own environment. |
| [CLI Docs](https://docs.kodus.io/how_to_use/en/cli/overview) | Run AI code reviews locally, in CI/CD, or inside coding agents. |
| [Discord Community](https://discord.gg/6WbWrRbsH7) | Ask questions, get setup help, and talk with the Kodus team. |
| [Pricing](https://kodus.io/pricing) | Compare Community, Teams, and Enterprise editions. |
| [Schedule a Call](https://cal.com/gabrielmalinosqui/30min) | Talk with the Kodus team about setup, self-hosting, or enterprise needs. |



## Contributing

<p align="left">
  <img src="https://kodus.io/wp-content/uploads/2026/06/kody-contributing-scaled.png" alt="Kody contributing" width="230" />
</p>

We welcome contributions of all sizes 🧡

Fix a typo, improve the docs, report a bug, suggest a feature, or open a pull request for something you think should exist.

Not sure where to start? Open an issue or join the community. We’re happy to help.
