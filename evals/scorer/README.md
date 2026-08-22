# Scorer do benchmark

Pontua uma **submission** contra os golden comments do dataset e emite um **scorecard**.

Separa **pontuar** de **rodar**. Antes, `run-recall.js` fazia tudo numa passada e
descartava as findings do modelo. Consequências: trocar de judge exigia re-rodar
todos os modelos (uma passada custa US$ 15–80 por modelo; o judge custa centavos),
o site não tinha dado para as páginas de trace, e terceiro nenhum conseguia participar.

```
harness (caro, roda uma vez)  →  submission.json  →  scorer (barato, roda sempre)  →  scorecard.json  →  site
```

## Uso

```bash
node evals/scorer/cli.js --submission=sub.json                    # pontua
node evals/scorer/cli.js --submission=sub.json --validate         # só valida schema
node evals/scorer/cli.js --submission=sub.json --judge=gpt-5.4-mini
```

Judge: `--judge=<modelo>` ou `JUDGE_MODEL` (default `claude-haiku-4-5`). A chave vem
do provider do judge via `recall-judge.js` — aceita API key (`sk-ant-api…`) e
credencial OAuth do `ant auth login` (`sk-ant-oat…`).

## Formato: submission

O que um participante entrega. `results[].findings` vazio é válido e significativo
("não achei nada neste PR") — não é o mesmo que não submeter o caso.

```json
{
  "benchmarkVersion": "light-30-v1",
  "run": {
    "harness":  { "name": "kodus", "version": "1.4.2", "commit": "abc123" },
    "model":    { "id": "gpt-5.6-luna", "provider": "openai", "accessPath": "api" },
    "executionMode": "replay",
    "runAt": "2026-08-04T14:00:00Z"
  },
  "results": [
    {
      "caseId": "add-guest-management-functionality-to-existing-bookings-cal-com",
      "findings": [
        {
          "path": "packages/features/bookings/lib/handleNewBooking.ts",
          "startLine": 412,
          "endLine": 418,
          "severity": "high",
          "category": "bug",
          "description": "Comparação de e-mail case-sensitive permite burlar a blacklist."
        }
      ],
      "usage": { "inputTokens": 512340, "outputTokens": 8210 },
      "latencyMs": 48120,
      "trace": { "replayCalls": 46, "unexpectedToolCalls": [] }
    }
  ]
}
```

### Campos de `run`

| campo | obrigatório | nota |
|---|---|---|
| `harness.name` | sim | `kodus`, `claude-code`, `codex`, `greptile`… O harness é dimensão de primeira classe: o mesmo modelo em motores diferentes é entrada diferente. |
| `model` | não | `null` quando o harness não deixa escolher modelo (produto fechado). |
| `model.accessPath` | não | `api` \| `subscription` \| `local` \| `unknown`. Regimes de cobrança/limite diferentes não são comparáveis em latência — declare. |
| `executionMode` | sim | `replay` (tool outputs gravados, determinístico) ou `live` (rodou no repo de verdade). **Só compare dentro do mesmo modo.** |
| `reasoning` | não | `{config, effortRequested}`. `config` ∈ `vendor-default` \| `explicit` \| `disabled`. Ver abaixo — é confundidor real. |
| `runAt` | sim | ISO-8601. |

### Reasoning é confundidor, não detalhe

O harness não força effort, então cada fornecedor aplica o próprio default — e eles
divergem muito. Medido no light 30: `deepseek-v4-flash` gerou **49k tokens de output
por caso** e `gpt-5.6-luna` **5,9k** — 8x, ambos "no default".

Isso significa que um ranking sem esse campo embute **calibração de vendor** como se
fosse qualidade de modelo. Duas posturas são defensáveis, e são benchmarks diferentes:

- **`vendor-default`** — o que um time recebe ao plugar o modelo. Mais útil para
  decisão de compra, e é o padrão aqui.
- **`explicit`** — effort fixo entre modelos, isola capacidade. Mas nem todo
  fornecedor expõe o mesmo controle, então a paridade é parcial por construção.

Qualquer que seja, **declare**. Comparar entradas com `config` diferente sem rotular
é o mesmo erro que comparar `replay` com `live`.

### Campos de `findings[]`

`description` é o único obrigatório — é o texto que o judge compara contra o golden.
Os demais (`path`, `startLine`, `endLine`, `severity`, `category`) enriquecem o site
e análises futuras, mas não entram no matching hoje.

## Formato: scorecard

Carrega o bloco `run` inteiro da submission (proveniência) mais o judge usado, e:

| métrica | o que é |
|---|---|
| `recallMicro` | goldens cobertos / total de goldens. **É o número para ranking** — pondera por bug, não por PR. |
| `recallMacro` | média dos recalls por caso. Comparável com o histórico do `finder-recall`. |
| `precisionMacro` | das findings emitidas, quantas acertaram um golden. |
| `f1Macro`, `fairRecallMacro` | idem `recall-assertion.js`. |
| `loopFidelityMacro` | só em `replay` com `trace`; `null` quando não medido. |

## Modos de execução

`replay` serve tool outputs gravados: determinístico, barato, comparável — mas
favorece harness que não explora além do que foi gravado (é o que `loopFidelity`
mede). `live` roda no repo real no SHA fixado: realista, porém cada execução vê
algo diferente. Produto fechado (Greptile, CodeRabbit) só consegue `live`.

Por isso o modo é **campo, não decisão** — e rankings devem ser segmentados por ele.

## Submissão de terceiro

Abrir PR com o arquivo de submission. O CI valida schema (`--validate`) e roda o
scorer. O que o revisor confere: `caseId`s existem, `benchmarkVersion` bate,
`executionMode` condiz com o harness declarado, e o `harness.commit` é verificável.

## Limitações conhecidas

- **Goldens são públicos** (vêm do `withmartian/code-review-benchmark`). Um
  participante pode otimizar para o gabarito. Um test set rotativo resolveria;
  `evals/kody-rules/harvest-github-cases.js` já colhe PRs novos do GitHub.
- **O judge é um LLM e tem viés de família.** Judge da mesma família de um
  concorrente avaliado é conflito — use painel cross-vendor e publique o
  agreement (`evals/investigation/agreement/`). Como o scorer é separado,
  re-pontuar com outro judge não custa nada.
- **Matching é por texto**, não por linha. Uma finding certa descrita de forma
  vaga pode não casar; `path`/`startLine` são coletados mas ainda não usados.
