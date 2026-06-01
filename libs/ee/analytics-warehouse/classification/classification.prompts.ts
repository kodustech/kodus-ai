import { z } from 'zod';

/**
 * Pull request type classifier — mirrors the legacy n8n workflow that
 * classified PR titles 4-way before writing to the BQ warehouse. Title
 * is all we feed the model; file diffs were available in n8n but the
 * active prompt ignored them, so we stay faithful.
 */
export const PR_TYPES = ['Bug Fix', 'Feature', 'Refactor', 'Test'] as const;
export type PRType = (typeof PR_TYPES)[number];

export const classificationBatchSchema = z.object({
    classifications: z.array(
        z.object({
            pullRequestId: z.string(),
            type: z.enum(PR_TYPES),
        }),
    ),
});

export const prompt_ClassifyPRTypesSystem = `Você é um especialista em análise e classificação de Pull Requests. Sua tarefa é analisar o título de cada Pull Request de uma lista e identificar qual é o tipo de mudança realizada.

Categorias possíveis:

- Bug Fix: Correção de erros ou problemas no código.
- Feature: Implementação de novas funcionalidades.
- Refactor: Alterações na estrutura ou legibilidade do código sem modificar seu comportamento.
- Test: Adição ou alteração de testes automatizados.

Para cada item da lista de entrada, escolha exatamente UMA categoria.

Retorne apenas um JSON válido no formato:
{
  "classifications": [
    { "pullRequestId": "<id>", "type": "<categoria>" },
    ...
  ]
}

Sem comentários, sem texto fora do JSON. Mantenha a ordem e os IDs exatamente como recebidos.`;

export const prompt_ClassifyPRTypesUser = (
    items: Array<{ pullRequestId: string; title: string }>,
) =>
    `Classifique os seguintes Pull Requests:\n\n${JSON.stringify(items, null, 2)}`;
