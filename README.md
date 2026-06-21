<p align="center">
  <img alt="koduslogo" src="https://kodus.io/wp-content/uploads/2025/04/kodusai.png">
</p>

# Kodus

AI Code Review with Full Control Over Model Choice and Costs.

<p align="left">
   <a href='http://makeapullrequest.com'><img alt='PRs Welcome' src='https://img.shields.io/badge/PRs-welcome-darkgreen.svg?style=shields'/></a>
   <a href="https://github.com/kodustech/kodus-ai" target="_blank"><img src="https://img.shields.io/github/stars/kodustech/kodus-ai" alt="Github Stars"></a>
   <a href="./license.md"><img src="https://img.shields.io/badge/license-AGPLv3-red" alt="License"></a>
</p>

---

[Website](https://kodus.io) · [Community](https://discord.gg/6WbWrRbsH7) · [Docs](https://docs.kodus.io) · [CLI Docs](https://docs.kodus.io/how_to_use/en/cli/overview) · **[Try Kodus Cloud »](https://app.kodus.io)**
· **[Self-Host Guide](https://docs.kodus.io/how_to_deploy/en/deploy_kodus/generic_vm)**

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/kodus-selfhosted?referralCode=0Dmi0j&utm_medium=integration&utm_source=template&utm_campaign=generic)

## Why Teams Choose Kodus

- **Model Agnostic**: Use Claude, GPT-5, Gemini, Llama, GLM, Kimi or any OpenAI-compatible endpoint.
- **Zero Markup on LLM Costs**: You pay model providers directly. No hidden multipliers.
- **Learns from Your Context**: Kody adapts to your architecture, standards, and workflow.
- **You Set the Rules**: Define custom review rules in plain language.
- **Privacy & Security**: Source code is not used to train models, data is encrypted in transit and at rest, and self-hosted runners are supported. Self-hosted instances send one anonymous heartbeat per day (aggregated counters only — no code, names, or identifiers); opt out with `KODUS_TELEMETRY_DISABLED=true`. See [Anonymous Telemetry](https://docs.kodus.io/how_to_deploy/en/deploy_kodus/telemetry).
- **Native Git Workflow**: Works directly in PRs with GitHub, GitLab, Bitbucket, and Azure Repos.
- **CLI + CI/CD Ready**: Run reviews locally and in pipelines.
- **Operational Impact**: Track technical debt and delivery metrics while keeping review quality high.

## Getting Started

### Cloud Edition

- [Create a free account](https://app.kodus.io/signup)
- [View pricing](https://kodus.io/pricing)

### Self-Hosted Edition

- [Deploy with Railway Template](https://railway.com/deploy/kodus-selfhosted?referralCode=0Dmi0j&utm_medium=integration&utm_source=template&utm_campaign=generic)
- [Installation Guide (CLI)](https://docs.kodus.io/how_to_deploy/en/deploy_kodus/generic_vm)
- [Installation Guide (Docker)](https://docs.kodus.io/how_to_deploy/en/deploy_kodus/generic_vm)
- [Join Discord for setup help](https://discord.gg/6WbWrRbsH7)

### CLI

- [CLI Overview](https://docs.kodus.io/how_to_use/en/cli/overview)
- [CLI Commands](https://docs.kodus.io/how_to_use/en/cli/commands)
- [CLI in CI/CD](https://docs.kodus.io/how_to_use/en/cli/ci_cd)

### Monorepo Structure

- Backend services: `apps/api`, `apps/webhooks`, `apps/worker`
- Web frontend (Next.js): `apps/web`
- Shared code: `libs`, `packages`

For local setup, see [Local Quickstart](https://docs.kodus.io/how_to_deploy/en/local_quickstart/orchestrator).

## Open Source vs. Teams vs. Enterprise

| Feature | Community | Teams | Enterprise |
| --- | --- | --- | --- |
| Price | Free | $10/dev monthly or $8/dev annual (+ tokens/dev) | Custom |
| Hosting | Self-hosted **or** hosted by Kodus | Hosted by Kodus | Self-hosted **or** hosted by Kodus  |
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

[View full comparison →](https://kodus.io/pricing)

## Have Questions?

Our team is here to help. [Schedule a 30-minute call](https://cal.com/gabrielmalinosqui/30min) with our founder.

## Contributing

We welcome contributions from the community.
