# instructions-trace-debugger.md

> **Para que serve este arquivo.** O *trace debugger* é uma página HTML gerada
> ao fim de cada rodada do eval. Ela responde, para a rodada inteira e para cada
> PR: **o que entrou, como foi processado em cada fase, o que saiu e onde deu
> errado.**
>
> Este documento explica como ela é gerada, como acessá-la e como ler cada
> seção. Se você nunca viu o pipeline, a própria página tem um explicador das
> fases no topo — comece por ele.
>
> Leitura anterior: `instructions-setup.md` (ambiente) e `instructions-eval.md`
> (como rodar).

---

## 1. Como ela é gerada

**O protocolo gera sozinho.** Ao rodar

```bash
./protocolo.sh <modelo> [nome]
```

a última fase escreve a página em:

```
evals/investigation/results/debugger-<nome-da-rodada>.html
```

Não há comando a decorar no caminho feliz. O caminho aparece no fim do log do
protocolo.

### Gerar de novo, sem re-rodar nada

Isso é comum: você roda o protocolo, depois acrescenta o verify (ou re-roda o
judge) e quer a página atualizada. Ela é construída **só a partir de arquivos já
gravados** — não faz nenhuma chamada a LLM, então é instantânea e de graça:

```bash
cd evals/investigation
node build-trace-debugger.js --run=<nome-da-rodada>
```

Opcional: `--out=<arquivo.html>` para escrever em outro lugar.

### Abrir

```bash
open results/debugger-<nome>.html            # macOS
xdg-open results/debugger-<nome>.html        # Linux
```

É um arquivo único, sem dependência externa. Dá para mandar por Slack, anexar
num issue ou abrir de outra máquina — abre igual.

---

## 2. De onde vêm os dados

Só a primeira fonte é obrigatória. As outras enriquecem a página; faltando
alguma, ela abre do mesmo jeito e diz o que não está disponível, em vez de
quebrar ou — pior — mostrar número sem base.

| fonte | o que acrescenta | sem ela |
|---|---|---|
| `pools/<run>/*.raw.txt` | geração, reducer em fluxo, tempos, tokens, comentários postados | **a página não abre** |
| `results/matriz-<run>.json` | o judge: qual candidato casa com qual golden | sem recall, precisão, F1, F2 e sem a coluna "gabarito" |
| `results/seletor-<run>.json` | atribuidor rodado offline | nada muda no essencial (o reducer em fluxo já traz os grupos) |
| `results/score2-<run>.json` | veracidade offline | idem |
| `results/verify-<run>.json` | verify offline | some a coluna "verify" da tabela de grupos |

Os quatro cartões no topo da página dizem quais fontes esta rodada tem.

---

## 3. As seções, em ordem

### Cabeçalho
Modelo, quantos PRs têm dump, quantos goldens core existem no conjunto e quando
a página foi gerada.

> **Olhe primeiro "PRs com dump".** Se não for **30/30**, a rodada está
> incompleta e **não pode ser comparada com nenhuma outra** — o denominador
> encolhido infla o recall sozinho. A página avisa em vermelho.

### Como esta página funciona
O explicador das fases. Cada fase tem uma etiqueta:

- **PRODUÇÃO** — roda de verdade quando um PR é revisado
- **OFFLINE** — existe só para medir, e nunca influencia o que o desenvolvedor receberia

São seis de produção (microagentes → simulação → filtro de contrato →
atribuidor → veracidade → fórmula) e as offline (judge, verify).

### O funil da rodada
Cinco números em sequência: goldens a achar → achados brutos → passam no
contrato → grupos → comentários postados. É a leitura de 5 segundos: onde o
material some.

### Métricas
Pré-reducer e pós-reducer, com tp, fp, recall, precisão, F1 e F2.

- **Pré-reducer** — como se cada achado bruto virasse um comentário. Mede a
  **geração**.
- **Pós-reducer** — o que de fato seria postado. Mede **geração + corte**.

Regra: por golden vence o candidato de maior confiança; candidato que não vence
nenhum golden é falso positivo. Perfil *core* (111 dos 120 goldens).

### Agentes
Por agente: achados, passadas, quantas voltaram vazias, passos, ferramentas e
tempo.

> **"Vazias" alto é normal e desejado.** Cada agente carrega uma classe só, e a
> maioria dos PRs não tem defeito daquela classe. O prompt diz explicitamente
> que zero é resposta válida — achado forçado custa mais que passar batido.

### Tempo e tokens
Menor, mediana, média e maior por fase. Duas linhas que se confundem:

- **Review inteira (parede)** — do começo ao fim do PR. É o número que importa
  para qualquer mudança que prometa velocidade.
- **Soma das passadas** — tempo de agente. As 14 rodam em paralelo, então essa
  soma é **maior** que a parede. Não use uma no lugar da outra.

### Erros
Tudo que alguma fase reportou: aviso de geração, reducer que não deu `success`,
atribuidor que falhou, verify que quebrou, PR sem dump. Vazio significa que
nenhuma fase reclamou.

### PR a PR
Uma linha por PR, clicável. Os botões filtram só os com problema e abrem/fecham
tudo de uma vez.

Aberto, cada PR mostra na ordem do pipeline:

| bloco | o que responde |
|---|---|
| **Entrada** | quantos arquivos entraram, se bate com o que o PR mexeu de verdade (comparado com `git diff` no clone), tamanho do diff, se o repositório real foi montado |
| **1 · Microagentes** | por agente: achados, passos, ferramentas, leituras de arquivo, tokens e tempo |
| **2 · Simulação mental** | o mesmo, para a passada que roda depois vendo o que a fase 1 levantou |
| **3 · Filtro de contrato** | quais achados caíram e **por quê** (sem `reason`, severidade fora da escala) |
| **4-6 · Atribuidor → Veracidade → Fórmula** | um grupo por linha: membros, agentes que o produziram, nota, veracidade, verify (se houver), probabilidade, decisão e se acerta algum golden |
| **Saída** | os comentários exatamente como o desenvolvedor os veria |
| **Gabarito** | cada golden core: alcançado ou nunca achado, e qual agente o alcançou |

O link do Langfuse fica no topo do bloco aberto, para quando você quiser ver a
chamada crua.

---

## 4. Perguntas frequentes, respondidas pela página

| pergunta | onde olhar |
|---|---|
| "esse PR gerou pouco, por quê?" | bloco **1 · Microagentes** — passos e ferramentas por agente |
| "esse achado bom foi cortado por quem?" | bloco **4-6** — a coluna decisão, com nota, veracidade e probabilidade |
| "o agente leu o repositório mesmo?" | bloco **Entrada** — `worktree real` ou `replay` |
| "faltou arquivo no prompt?" | bloco **Entrada** — comparação contra `git diff` |
| "por que o recall caiu?" | **Métricas** pré vs pós-reducer. Se caiu no pré, é geração; se só no pós, é corte |
| "qual golden a gente nunca acha?" | bloco **Gabarito**, linhas marcadas `nunca achado` |
| "onde foi o tempo?" | **Tempo e tokens**, e o tempo por agente dentro do PR |
| "deu erro em algum lugar?" | seção **Erros**, e o filtro "só com problema" |

---

## 5. Armadilhas de leitura

**Pré-reducer não é resultado do produto.** Ele conta como se todos os achados
brutos virassem comentário. Serve para medir a geração isoladamente. O que um
desenvolvedor receberia é a linha pós-reducer.

**Sem judge não existe acerto.** Se o cartão "judge disponível" estiver em
vermelho, a página mostra contagens (quantos achados, quantos grupos) mas
nenhuma métrica de qualidade. Rode `matriz-prefilter.js --dump=<run>` e gere a
página de novo.

**Comparar duas rodadas exige cuidado.** A variância entre rodadas da mesma
configuração chega a **8pp de recall**, e o piso de ruído do F1 é **0,026**.
Diferença menor que isso não é efeito. Quando der, compare braços da mesma
rodada.

**"Cortado" não quer dizer errado.** Um grupo cortado pode ser defeito real que
ficou abaixo da cota. A coluna "gabarito" diz se ele acertava algum golden — é
ali que se vê se o corte doeu.

---

## 6. Se a página não gerar

| erro | causa | o que fazer |
|---|---|---|
| `não achei pools/<run>` | nome errado, ou a geração não rodou | confira `ls evals/investigation/pools/` |
| abre, mas sem métricas | falta a matriz do judge | `node matriz-prefilter.js --dump=<run> --par=10 --out=results/matriz-<run>.json` |
| PRs aparecem como "sem dump" | a geração falhou naqueles PRs | veja `results/run-<run>.log`; se houver INFRA, a rodada não serve e deve ser refeita inteira |
| tabela de grupos vazia | a rodada não usou o reducer em fluxo | rode com `RECALL_REDUCER=v2` (o protocolo já faz) |
