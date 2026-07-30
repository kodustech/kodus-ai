# Padrões de dados & forms (`apps/web`)

Guia curto de convenções para React Query (v5) e React Hook Form (v7),
alinhado à doc oficial. Objetivo: consistência, não reescrever o que já
funciona.

## React Query (`@tanstack/react-query` v5)

**Provider** (`core/providers/query.provider.tsx`): já configurado com
`staleTime: 60s`, `retry: 2` + backoff, `refetchOnWindowFocus: false`. Não
duplicar esses defaults por query — só sobrescrever quando o dado exige
(ex.: `staleTime` maior para versão/estrelas do GitHub).

**Streaming SSR**: `@tanstack/react-query-next-experimental` foi **removido**
(estava instalado e não usado — nenhum `<ReactQueryStreamedHydration>`). Se um
dia quiserem prefetch de queries em Server Components com hydration streaming,
reintroduzir a dep e envolver os children no provider — num PR próprio, com os
gates de SSR.

**Prefira `queryOptions()`** para co-locar key + fn + opções e reusar em
`useQuery` / `prefetchQuery` / `invalidateQueries` / `setQueryData` com
type-safety:

```ts
// core/queries/user.ts
import { queryOptions } from "@tanstack/react-query";

export const userQuery = (id: string) =>
    queryOptions({
        queryKey: ["user", id],
        queryFn: () => axiosAuthorized.get(`/users/${id}`),
        // staleTime só se diferente do default global
    });

// uso
useQuery(userQuery(id));
queryClient.invalidateQueries({ queryKey: userQuery(id).queryKey });
```

Migração dos ~81 sites com `generateQueryKey` é **incremental** — adote
`queryOptions` em código novo e ao encostar em hooks existentes; não é um
refactor de uma vez.

**Invalidação**: use o callback `onSuccess` do `useMutation` (o `useMutation`
mantém callbacks no v5) e retorne a Promise do `invalidateQueries` para o
mutation só concluir após o refetch:

```ts
useMutation({
    mutationFn: updateThing,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["things"] }),
});
```

## React Hook Form (v7)

**`Controller` é o padrão correto aqui** — a doc recomenda `Controller` para
libs de UI sem `ref` (react-select, Radix), que é o grosso dos componentes de
vocês. Não migrar para `register` em massa. Use `register` apenas em `<input>`
nativo puro, onde é mais leve.

**Validação por schema**: padronizar `zodResolver` nos forms com regras de
negócio (hoje ~36 de ~114 `useForm` usam). Forms triviais (um campo, sem
regra) podem seguir sem resolver — decisão por form, não regra cega.

```ts
const form = useForm({
    resolver: zodResolver(Schema),
    defaultValues: { ... }, // sempre definir para inputs controlados
});
```

**Isolar re-render**: para ler um campo em subcomponente sem prop-drilling,
`useWatch({ control, name })` em vez de `watch()` no topo (limita o re-render
ao campo).

**`useFormContext`** (72 usos): ok para forms grandes/aninhados; passar
`control` via prop também é válido para 1-2 níveis.
