# Plano crítico de melhorias da documentação (foco em boas práticas gerais)

Este plano foca no que está faltando e no que pode ser melhorado na documentação atual, com base em boas práticas de engenharia e padrões observados em organizações que adotam revisões de código assistidas por IA. Não implementa mudanças — apenas prioriza e detalha o que deve ser feito.

## Objetivos
- Tornar explícito o fluxo ponta-a-ponta de revisão com Kody e CI, incluindo quem revisa e quando.
- Explicitar políticas de uso (sugestões vs bloqueios), modos de operação (opt-in/autoreview) e limites.
- Cobrir resolução de problemas práticos (Kody não responde, falsos positivos, permissões).
- Adicionar FAQ de operação, melhores práticas de PR e integrações de notificações.
- Endereçar lacunas de localização pt-BR e higiene dos próprios docs.

## Diagnóstico rápido do repositório
- Navegação pt-BR sem conteúdos: `docs.json:107`–`docs.json:113` aponta para `pt-BR` com páginas vazias.
- README desatualizado/genérico do Mintlify: `README.md:1` ainda orienta para `mint.json`, enquanto o projeto usa `docs.json`.
- Configurações de revisão aparecem em diversos pontos e com pequenas repetições/inconsistências (ex.: `how_to_use/en/code_review/configs/general.mdx:1` e sobreposição de seções de “Automated Review”, “PR Workflow”).
- Não há página única e clara sobre “papéis dos checks” (required vs informational) e impacto no merge.
- Não há guia de “Fluxo Visual” da revisão (flowchart) ponta-a-ponta.

## Lacunas específicas vs. boas práticas observadas
1) Fluxo de Code Review (flowchart) do PR ao merge
- Ausência de um diagrama/visão de alto nível com: abertura do PR → execução de checks (CI, Snyk, Sonar etc.) → Kody (auto/manual) → aprovações humanas → merge.
- Ação: Nova página “Code Review Flow” com diagrama; linkar de Quickstart e Concepts.

2) Quem revisa meu código? (ownership e auto-assign)
- Falta orientação sobre auto-assign de revisores/humanos e como Kody se insere nisso (não substitui aprovação humana).
- Ação: Seção “Team ownership e auto-assign” na mesma página de fluxo, com notas sobre boas práticas de tagging.

3) Modos de operação do Kody (opt-in vs autoreview) e como checar a configuração
- Hoje está disperso; precisa ficar cristalino: quando Kody roda sozinho, quando precisa de `@kody start-review`, e como inspecionar a configuração ativa no PR.
- Ação: Nova subseção “Modes” em Concepts consolidando: Autoreview, Opt-in/Manual, Cadência de re-reviews; adicionar “Como perguntar ao Kody a configuração do projeto” (comando suportado) e link para Troubleshooting.

4) Interação com Kody: sugestões vs exigências (política)
- A documentação deve deixar claro quando Kody atua como fonte de sugestões e quando pode sinalizar bloqueios (se configurado), com orientação de uso recomendado.
- Ação: Nova página “Política de Revisão com Kody” explicando comportamentos possíveis, defaults recomendados e quando ativar/desativar bloqueios.

5) Tipos de checks: Required vs Informational
- Falta uma página que explique o status das checagens, impacto no botão de merge e como as decisões cabem aos revisores humanos.
- Ação: Nova página “Checks: Required vs Informational” com tabelas por plataforma (GitHub/GitLab/Bitbucket/Azure) e exemplos práticos.

6) Kody não respondendo (checklist operacional)
- Já há “Troubleshooting”, mas faltam itens operacionais práticos: verificar se há arquivos relevantes para revisão (não só docs), filtros de branch, limites (nº de arquivos), e passos de escalonamento.
- Ação: Expandir `how_to_use/en/code_review/troubleshooting.mdx:1` com checklist sucinta + instruções de escalonamento/suporte.

7) Discordâncias com regras e falsos positivos
- Hoje temos páginas de Rules, mas falta o fluxo humano: pedir explicação (@kody), discutir no PR, propor mudança, onde sugerir ajustes globais.
- Ação: Nova página “Lidando com falsos positivos e evolução de regras” com exemplos de comentários e referências a “Kody Rules” + “Plugins” para editar regras a partir do PR.

8) Boas práticas de PR (tamanho, PRs empilhados)
- Falta uma seção prescritiva (“200–400 linhas”, PRs menores e empilhados) conectada com a métrica “PR Size”.
- Ação: Nova seção “Boas práticas de PR” com referências a `how_to_use/en/cockpit/metrics/pr_size.mdx:1`.

9) Conhecidas dores/limitações e roadmap
- A documentação carece de uma página “Known issues & limitations” com mitigação e status/changelog.
- Ação: Nova página “Limitações conhecidas & Roadmap/Changelog” com transparência sobre ruído, permissões, limites (ex.: PRs >200 arquivos), performance.

10) Preciso de conta? (acesso e papéis)
- Falta uma FAQ clara “Preciso de conta para usar o Kody?” explicando cenários: operar só via PR vs administrar no app.
- Ação: Nova página em Getting Started “Contas, Acesso e Papéis” e cross-link com Workspace Roles.

- Integrações de notificação (Slack/Google Chat)
- Muitas equipes usam salas/canais para PRs. Não temos doc central de notificações/canais.
- Ação: Nova página “Integrações de Notificação” com instruções para Slack/Google Chat (alto nível) e práticas de adoção.

- Perguntar ao Kody sobre a configuração do projeto
- É útil poder perguntar “@kody what is the setup for this project?”. Essa capacidade não está documentada.
- Ação: Documentar comando suportado e limitações, ou registrar como “em beta/experimento” se aplicável, com caminho alternativo no app.

## Plano por fases (priorizado)
Fase 1 — Essenciais orientados ao usuário
- Página “Code Review Flow” com diagrama e papéis de cada etapa.
- Página “Checks: Required vs Informational” (impacto no merge e defaults por plataforma).
- Seção “Modes (opt-in/autoreview/cadência) + Como checar a configuração” em Concepts.
- Página “Política de Revisão com Kody” (sugestões vs bloqueios; quando usar Request Changes/Auto-approve).

Fase 2 — Operação e qualidade
- Expandir Troubleshooting com checklist “Kody não respondendo”.
- Página “Lidando com falsos positivos e evolução de regras” com exemplos de comentários e fluxo de aprovação de mudanças.
- Boas práticas de PR (tamanho, PRs empilhados) com ligação às métricas.

Fase 3 — Integrações e exemplos
- Página “Integrações de Notificação (Slack/Google Chat)” com cenários comuns.
- Documentar “Pergunte ao Kody a configuração do projeto” (ou marcar como beta/limitação, com alternativas).
- Adicionar exemplos/ GIFs de comentários do Kody e uso de Plugins já existentes.

Fase 4 — Localização pt-BR (baseline)
- Traduzir: Introduction, Quickstart, Concepts, Troubleshooting, Política de Revisão, Checks, Boas práticas de PR.
- Atualizar navegação pt-BR em `docs.json:107`–`docs.json:113` com o subset acima.

Fase 5 — Higiene e consistência dos docs
- Atualizar `README.md:1` para refletir `docs.json` e instruções reais de dev (Mintlify CLI, comandos, estrutura de pastas).
- Consolidar duplicidades em `how_to_use/en/code_review/configs/general.mdx:1` (seções repetidas de Automated Review/PR Workflow).
- Criar página “Limitações conhecidas & Roadmap/Changelog”.

## Estrutura proposta (páginas novas)
- `how_to_use/en/code_review/flow.mdx` — “Code Review Flow (diagrama + papéis)”.
- `how_to_use/en/code_review/policy.mdx` — “Política de Revisão com Kody (sugestões vs bloqueios)”.
- `how_to_use/en/code_review/checks.mdx` — “Checks: Required vs Informational (por plataforma)”.
- `how_to_use/en/code_review/false_positives.mdx` — “Falsos positivos e evolução de regras”.
- `how_to_use/en/code_review/best_practices.mdx` — “Boas práticas de PR (tamanho, stacked PRs)”.
- `how_to_use/en/integrations/notifications.mdx` — “Integrações de Notificação (Slack/Google Chat)”.
- `how_to_use/en/faq/accounts_access.mdx` — “Preciso de conta? Acesso & papéis”.

Versões pt-BR (baseline):
- `how_to_use/pt-BR/overview.mdx`, `quickstart.mdx`, `code_review/flow.mdx`, `code_review/checks.mdx`, `code_review/policy.mdx`, `code_review/best_practices.mdx`, `code_review/troubleshooting.mdx` (adaptada), `faq/accounts_access.mdx`.

## Ajustes na navegação
- Adicionar as novas páginas em “AI Code Review” e “Getting Started”.
- Preencher a árvore `pt-BR` em `docs.json:107`–`docs.json:113` com o subset traduzido.
- Linkar “Boas práticas de PR” a `how_to_use/en/cockpit/metrics/pr_size.mdx:1`.

## Critérios de aceite
- Fluxo do PR documentado com diagrama e explicação textual clara.
- Modo de operação (opt-in/autoreview/cadência) e comando `@kody start-review` descritos de forma inequívoca, incluindo “como checar a configuração do projeto no PR”.
- Página de “Checks” explica impacto no merge e diferencia required/informational por plataforma.
- Troubleshooting cobre: arquivos não-revisáveis, filtros de branch, limites (p.ex., >200 arquivos), tokens/permissões, escalonamento.
- Guia de falsos positivos descreve um fluxo de resolução e evolução de regras no PR.
- FAQ “Preciso de conta?” esclarece trabalho só pelo PR vs. administração no app.
- Navegação pt-BR com pelo menos o baseline traduzido.
- README alinhado com a stack real do projeto (sem referências a `mint.json`).

## Riscos e decisões
- Neutralidade do produto vs. políticas organizacionais: documentar recursos do produto e, quando referenciar políticas (ex.: “Kody não bloqueia”), rotular como “recomendação” e não regra do produto.
- “Pergunte ao Kody a configuração do projeto”: se a feature ainda não estiver estável, documentar como beta/limitação e oferecer caminhos alternativos no app.
- Integrações de chat variam por cliente: fornecer guia alto nível e callbacks genéricas; evitar dependências de ferramentas internas específicas.

## Referências (arquivos atuais)
- `docs.json:107` — Navegação `pt-BR` vazia.
- `README.md:1` — README do Mintlify desatualizado.
- `how_to_use/en/code_review/concepts.mdx:1` — Conceitos e `@kody start-review` (carece de “Modes” consolidado e “como checar config”).
- `how_to_use/en/code_review/troubleshooting.mdx:1` — Troubleshooting (expandir com checklist prático e limites).
- `how_to_use/en/code_review/configs/general.mdx:1` — Config geral (consolidar seções, evitar duplicidade).
- `how_to_use/en/cockpit/metrics/pr_size.mdx:1` — Métrica de tamanho de PR (linkar nas melhores práticas).

---

Próximos passos sugeridos: validar a estrutura acima, aprovar naming/URLs das novas páginas e a priorização por fases. Após aprovação, seguimos para implementação incremental (Fase 1 → Fase 5).
