<p align="center">
  <img alt="logotipo do kodus" src="https://kodus.io/wp-content/uploads/2026/06/kodus-thumb-git-scaled.png">
</p>

<p align="center">
   <a href="http://makeapullrequest.com">
      <img alt="PRs bem-vindos" src="https://img.shields.io/badge/PRs-welcome-darkgreen.svg?style=shields" />
   </a>
   <a href="https://github.com/kodustech/kodus-ai" target="_blank">
      <img src="https://img.shields.io/github/stars/kodustech/kodus-ai" alt="Estrelas no Github" />
   </a>
   <a href="./license.md">
      <img src="https://img.shields.io/badge/license-AGPLv3-red" alt="Licença" />
   </a>
</p>

---

<p align="center">
   <a href="https://kodus.io">Website</a> ·
   <a href="https://discord.gg/6WbWrRbsH7">Comunidade</a> ·
   <a href="https://docs.kodus.io">Docs</a> ·
   <a href="https://docs.kodus.io/how_to_use/en/cli/overview">Docs da CLI</a> ·
   <strong><a href="https://app.kodus.io">Experimente o Kodus Cloud </a></strong> ·
   <strong><a href="https://docs.kodus.io/how_to_deploy/en/deploy_kodus/generic_vm">Guia de Self-Host</a></strong>
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

## Por Que as Equipes Escolhem o Kodus

- **Agnóstico de Modelo**: Use Claude, GPT-5, Gemini, Llama, GLM, Kimi ou qualquer endpoint compatível com OpenAI.
- **Sem Markup no Custo de LLM**: Você paga diretamente aos provedores de modelo. Sem multiplicadores ocultos.
- **Aprende com Seu Contexto**: Kody se adapta à sua arquitetura, padrões e fluxo de trabalho.
- **Você Define as Regras**: Defina regras de revisão personalizadas em linguagem natural.
- **Privacidade e Segurança**: O código-fonte não é usado para treinar modelos, os dados são criptografados em trânsito e em repouso, e runners self-hosted são suportados. Instâncias self-hosted enviam um heartbeat anônimo por dia (apenas contadores agregados — sem código, nomes ou identificadores); desative com `KODUS_TELEMETRY_DISABLED=true`. Veja [Telemetria Anônima](https://docs.kodus.io/how_to_deploy/en/deploy_kodus/telemetry).
- **Fluxo Git Nativo**: Funciona diretamente em PRs com GitHub, GitLab, Bitbucket e Azure Repos.
- **CLI + CI/CD Pronto**: Execute revisões localmente e em pipelines.
- **Impacto Operacional**: Acompanhe dívida técnica e métricas de entrega mantendo a qualidade da revisão alta.

## Destaques do Produto

<details>
  <summary><strong>🔑 Traga Sua Própria Chave (BYOK)</strong></summary>
<br />
Conecte suas próprias credenciais de provedor e escolha os modelos por trás das revisões do Kodus: OpenAI, Anthropic, Google Gemini, Vertex AI, Novita ou qualquer endpoint compatível com OpenAI. Mantenha o faturamento e o uso na sua própria conta do provedor, sem markups ocultos de LLM.

<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/byok-scaled.png" alt="Configuração de provedor de modelo BYOK do Kodus" width="900">
</p>

</details>

<br />

<details>
  <summary><strong>📈 Uso de Tokens</strong></summary>
<br />
Acompanhe o consumo de tokens nas revisões de código com IA, entenda os geradores de custo e mantenha o gasto com modelos previsível conforme a adoção cresce.

<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/token-usage-scaled.png" alt="Dashboard de uso de tokens do Kodus" width="900">
</p>

</details>

<br />

<details>
  <summary><strong>⚙️ Kody Rules</strong></summary>
<br />
Kody Rules permitem que as equipes definam instruções de revisão em linguagem natural e as apliquem em organizações, repositórios, paths ou escopos específicos de revisão. Kody usa essas regras como contexto ao revisar pull requests, ajudando a garantir decisões de arquitetura, expectativas de segurança, práticas de teste e convenções específicas de repositório sem depender de revisores para repetir o mesmo feedback manualmente.

<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/rules-scaled.png" alt="Regras do Kody" width="900">
</p>
</details>
<br />
<details>
  <summary><strong>📊 Cockpit</strong></summary>
<br />
Cockpit ajuda as equipes a medir a eficácia das revisões do Kodus, a saúde das Kody Rules, a saúde dos repositórios e as métricas de entrega em todo o fluxo de trabalho de engenharia.

<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/cockpit-kodus-scaled.png" alt="Cockpit do Kodus mostrando a saúde do pipeline de revisão de código com IA" width="900">
</p>

</details>

<br />

<details>
  <summary><strong>🧩 Kody Issues</strong></summary>
<br />
Acompanhe automaticamente sugestões não implementadas de PRs fechados, gerencie-as por status, severidade, categoria e repositório, e deixe Kody resolvê-las quando a correção aparecer em um PR futuro.
<br />
<br />

<p align="center">
  <img src="https://kodus.io/wp-content/uploads/2026/06/issues-scaled.png" alt="Dashboard do Kodus Issues" width="900">
</p>

</details>

<br />
<details>
  <summary><strong>🔎 Veja o Kody revisando um pull request real</strong></summary>
<br />
Kody faz mais do que resumir diffs. Ele revisa código com contexto, sinaliza riscos por severidade e sugere correções concretas diretamente no pull request.

<br />
<br />

<p align="center">
  <img
    src="https://kodus.io/wp-content/uploads/2025/12/review-kody-.png"
    alt="Kody detectando um problema crítico de segurança IDOR em uma revisão de pull request"
    width="700"
  />
</p>

Neste exemplo, Kody captura um risco crítico de IDOR onde um parâmetro de consulta `organizationId` poderia contornar a proteção de tenant quando passado como um array, e então sugere uma validação explícita em runtime antes que o código seja merged.

</details>

## Comece Agora

Escolha o fluxo de trabalho que corresponde a como você quer usar o Kodus.

<table>
  <tr>
    <td width="50%">
      <strong>Experimente o Kodus Cloud</strong>
      <br />
      Comece a revisar pull requests sem gerenciar infraestrutura.
      <br />
      <br />
      <a href="https://app.kodus.io/signup">Crie uma conta gratuita</a>
      ·
      <a href="https://kodus.io/pricing">Veja os preços</a>
    </td>
    <td width="50%">
      <strong>Faça self-host do Kodus</strong>
      <br />
      Faça deploy do Kodus na sua própria infraestrutura com controle sobre dados, modelos
      e configuração de runtime.
      <br />
      <br />
      <a href="https://docs.kodus.io/how_to_deploy/en/deploy_kodus/generic_vm">Guia de instalação</a>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>Use a CLI</strong>
      <br />
      Execute revisões de código com IA pelo seu terminal em uma árvore de trabalho, diff staged,
      branch ou commit.
      <br />
      <br />
      <code>kodus review</code>
      <br />
      <code>kodus review --staged</code>
      <br />
      <code>kodus review --prompt-only</code>
      <br />
      <br />
      <a href="https://docs.kodus.io/how_to_use/en/cli/introduction">Visão geral da CLI</a>
      ·
      <a href="https://docs.kodus.io/how_to_use/en/cli/commands">Referência de comandos</a>
      ·
      <a href="https://docs.kodus.io/how_to_use/en/cli/ci_cd">CI/CD</a>
    </td>
    <td width="50%">
      <strong>Contribua Localmente</strong>
      <br />
      Rode o monorepo do Kodus localmente para desenvolvimento na API, worker,
      serviço de webhooks, app web e infraestrutura local.
      <br />
      <br />
      <code>git clone https://github.com/kodustech/kodus-ai.git</code>
      <br />
      <code>cd kodus-ai</code>
      <br />
      <code>yarn setup</code>
      <br />
      <br />
      <a href="https://docs.kodus.io/how_to_deploy/en/local_quickstart/orchestrator">Quickstart local</a>
    </td>
  </tr>
</table>

## Estrutura do Monorepo

Kodus é um monorepo com múltiplas aplicações, bibliotecas de domínio compartilhadas e pacotes publicados.

```txt
kodus-ai/
├── apps/
│   ├── api/          # API NestJS
│   ├── web/          # Dashboard Next.js
│   ├── worker/       # Execução de revisões e consumidores de fila
│   └── webhooks/     # Ingestão de webhooks de provedores Git
├── libs/             # Módulos de domínio NestJS compartilhados
├── packages/
│   ├── kodus-flow/   # SDK de orquestração de agentes de IA
│   └── kodus-common/ # Pacote de abstração de LLM
└── scripts/          # Scripts de dev, deploy, benchmark e automação
```

| Path | Finalidade |
| --- | --- |
| `apps/api` | API NestJS principal para autenticação, organizações, equipes, Kody Rules, integrações, permissões e orquestração de revisão de código. |
| `apps/web` | Aplicação web Next.js para o dashboard do Kodus. |
| `apps/worker` | Serviço em background para execução de revisão de código, processamento de fila, verificação de sugestões, jobs de automação e tarefas de monitoramento. |
| `apps/webhooks` | Serviço de ingestão de webhooks para eventos do GitHub, GitLab, Azure Repos, Bitbucket e Forgejo. |
| `libs` | Módulos de domínio NestJS compartilhados usados nas aplicações do Kodus. |
| `packages/kodus-flow` | SDK para orquestração de agentes de IA. |
| `packages/kodus-common` | Pacote compartilhado de abstração de LLM para provedores de modelo. |

Para instruções completas de configuração, siga o [Quickstart Local](https://docs.kodus.io/how_to_deploy/en/local_quickstart/orchestrator).

## Open Source vs. Teams vs. Enterprise

| Recurso | <img src="https://kodus.io/wp-content/uploads/2026/06/kody-community2-scaled.webp" alt="Kody Community" width="110" /><br>Community | <img src="https://kodus.io/wp-content/uploads/2026/06/kody-team-scaled.webp" alt="Kody Teams" width="110" /><br>Teams | <img src="https://kodus.io/wp-content/uploads/2026/06/kody-enterprise-scaled.webp" alt="Kody Enterprise" width="110" /><br>Enterprise |
| :--- | :---: | :---: | :---: |
| Preço | Grátis | $10/dev mensal ou $8/dev anual (+ tokens/dev) | Personalizado |
| Hosting | Self-hosted **ou** hospedado pelo Kodus | Hospedado pelo Kodus | Self-hosted **ou** hospedado pelo Kodus |
| Traga Sua Própria Chave (BYOK) | ✅ | ✅ | ✅ |
| Uso de PR | PRs ilimitados usando sua própria API key | PRs ilimitados usando sua própria API key | PRs ilimitados usando a API key de Tokens do Kodus AI |
| Usuários | Ilimitados | Ilimitados | Ilimitados |
| Kody Rules | Até 10 | Ilimitadas | Ilimitadas |
| Plugins ativos | Até 3 | Ilimitados | Ilimitados |
| Kody Learnings e Memória | ✅ | ✅ | ✅ |
| Issues do Quality Radar | Ilimitadas | Ilimitadas | Ilimitadas |
| Fila prioritária para Kody Agents | ❌ | ✅ | ✅ |
| Métricas de Engenharia / Cockpit | ❌ | ✅ | ✅ |
| SSO | ❌ | ❌ | ✅ |
| RBAC + logs de auditoria + analytics | ❌ | ❌ | ✅ |
| Conformidade | ❌ | ❌ | SOC 2 |
| Suporte | Suporte da Comunidade no Discord | Comunidade no Discord + Suporte por Email | Discord Privado + Email + até 5h/mês de onboarding/suporte dedicado |

[Comparar todos os planos →](https://kodus.io/pricing)

## Recursos

| Recurso | Descrição |
| --- | --- |
| [Website](https://kodus.io) | Saiba mais sobre o Kodus, capacidades do produto e preços. |
| [Documentação](https://docs.kodus.io) | Guias de configuração, docs de produto, uso da CLI e instruções de self-host. |
| [Kodus Cloud](https://app.kodus.io) | Comece a usar o Kodus sem gerenciar infraestrutura. |
| [Guia de Self-Host](https://docs.kodus.io/how_to_deploy/en/deploy_kodus/generic_vm) | Faça deploy do Kodus no seu próprio ambiente. |
| [Docs da CLI](https://docs.kodus.io/how_to_use/en/cli/overview) | Execute revisões de código com IA localmente, em CI/CD ou dentro de agentes de codificação. |
| [Comunidade no Discord](https://discord.gg/6WbWrRbsH7) | Faça perguntas, obtenha ajuda de configuração e converse com a equipe do Kodus. |
| [Preços](https://kodus.io/pricing) | Compare as edições Community, Teams e Enterprise. |
| [Agende uma Chamada](https://cal.com/gabrielmalinosqui/30min) | Converse com a equipe do Kodus sobre configuração, self-host ou necessidades enterprise. |



## Contribuindo

<p align="left">
  <img src="https://kodus.io/wp-content/uploads/2026/06/kody-contributing-scaled.png" alt="Kody contribuindo" width="230" />
</p>

Recebemos contribuições de todos os tamanhos 🧡

Corrija um erro de digitação, melhore as docs, reporte um bug, sugira uma funcionalidade ou abra um pull request para algo que você acha que deveria existir.

Não sabe por onde começar? Abra uma issue ou entre na comunidade. Ficaremos felizes em ajudar.
