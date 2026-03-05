# Integração Backend - Conversão de Tiptap JSON para Texto

## Contexto

O editor de prompts salva o conteúdo como **JSON do Tiptap** para preservar formatação e menções MCP (`@mcp<app|tool>`).

Quando você for **enviar o prompt para o LLM**, precisa converter o JSON para **texto puro**.

## Solução

### 1. Copiar a função utilitária

Copie o arquivo `src/core/utils/tiptap-json-to-text.ts` para seu backend. A função é **pura JavaScript/TypeScript**, sem dependências do React ou Tiptap.

### 2. Uso no Backend

```typescript
import { convertTiptapJSONToText } from "./utils/tiptap-json-to-text";

// Quando receber o prompt do banco de dados (vem como JSON string):
const promptFromDB =
    '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Analyze "},{"type":"mcpMention","attrs":{"app":"kodus","tool":"kodus_list_commits"}},{"type":"text","text":" for bugs"}]}]}';

// Converter para texto antes de enviar ao LLM:
const promptText = convertTiptapJSONToText(promptFromDB);
// Resultado: "Analyze @mcp<kodus|kodus_list_commits> for bugs"

// Agora pode enviar promptText para o LLM
sendToLLM(promptText);
```

### 3. Onde aplicar a conversão

Aplique a conversão **ANTES de enviar para o LLM**:

- **Campos de prompt que usam o RichTextEditor:**
    - `v2PromptOverrides.generation.main.value`
    - `v2PromptOverrides.categories.descriptions.*.value`
    - `v2PromptOverrides.severity.flags.*.value`

### 4. Exemplo prático

```typescript
// Exemplo: Endpoint que processa code review
async function processCodeReview(config: CodeReviewConfig) {
    // Converter prompts antes de usar
    const mainPrompt = convertTiptapJSONToText(
        config.v2PromptOverrides?.generation?.main?.value,
    );

    const bugPrompt = convertTiptapJSONToText(
        config.v2PromptOverrides?.categories?.descriptions?.bug?.value,
    );

    // Agora pode construir o prompt final para o LLM
    const fullPrompt = `
    ${mainPrompt}
    
    When analyzing for bugs:
    ${bugPrompt}
  `;

    return await sendToLLM(fullPrompt);
}
```

### 5. Compatibilidade

A função funciona com:

- ✅ JSON string: `'{"type":"doc",...}'`
- ✅ JSON object: `{ type: "doc", ... }`
- ✅ Texto puro: `"hello world"` (retorna como está)
- ✅ Null/undefined: retorna `""`

### 6. Formato dos tokens MCP

Os tokens são preservados no formato:

```
@mcp<app_name|tool_name>
```

Exemplo:

- `@mcp<kodus|kodus_list_commits>`
- `@mcp<jira|search_issues>`

## Implementação Backend (JavaScript/TypeScript puro)

Se preferir, você pode usar esta versão simplificada no backend:

```typescript
function convertTiptapJSONToText(
    content: string | object | null | undefined,
): string {
    if (!content) return "";

    if (typeof content === "string") {
        if (content.startsWith("{") && content.trim().startsWith("{")) {
            try {
                return convertTiptapJSONToText(JSON.parse(content));
            } catch {
                return content;
            }
        }
        return content;
    }

    if (typeof content === "object" && content !== null) {
        try {
            let text = "";
            function traverse(node: any): void {
                if (!node || typeof node !== "object") return;
                if (node.type === "text") {
                    text += node.text || "";
                } else if (node.type === "mcpMention") {
                    text += `@mcp<${node.attrs?.app || ""}|${node.attrs?.tool || ""}>`;
                } else if (node.content && Array.isArray(node.content)) {
                    node.content.forEach(traverse);
                }
            }
            traverse(content);
            return text;
        } catch {
            return "";
        }
    }

    return "";
}
```

## Notas

- ⚠️ **NÃO** envie o JSON diretamente para o LLM
- ✅ **SEMPRE** converta usando `convertTiptapJSONToText()` antes de enviar
- ✅ Os tokens `@mcp<app|tool>` são preservados no texto final
- ✅ A função é idempotente (pode chamar várias vezes sem problema)
