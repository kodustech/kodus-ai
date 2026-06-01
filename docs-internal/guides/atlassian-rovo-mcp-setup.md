# Configurando o Atlassian Rovo MCP Server com a Kodus

Guia passo a passo para conectar o Atlassian Rovo MCP (Jira, Confluence) via OAuth 2.1 na plataforma Kodus.

## Pre-requisitos

- Conta Atlassian Cloud com Jira e/ou Confluence
- Acesso de **Organization Admin** no Atlassian (admin.atlassian.com)
- O primeiro usuario a completar o fluxo OAuth precisa ter acesso aos apps Atlassian solicitados (Jira, Confluence)

## Passo 1: Configurar dominio no Rovo MCP Server

O admin da organizacao precisa liberar o redirect URI da Kodus no servidor Rovo MCP.

1. Acesse [admin.atlassian.com](https://admin.atlassian.com)
2. Selecione sua organizacao (ex: `kodustech`)
3. No menu lateral, va em **Rovo** > **Servidor MCP do Rovo**
4. Na secao **"Seus dominios"**, clique em **"Adicionar dominio"**
5. Adicione a URL completa do redirect URI:

```
https://app.kodus.io/setup/mcp/oauth
```

## Troubleshooting

### Erro: "Your organization admin must authorize access from a domain to this site"

**Causa:** O redirect URI da Kodus nao esta cadastrado no Rovo MCP server.

**Solucao:**

1. Acesse [admin.atlassian.com](https://admin.atlassian.com) > **Rovo** > **Servidor MCP do Rovo**
2. Adicione `https://app.kodus.io/setup/mcp/oauth` na lista de dominios
3. Tente o fluxo OAuth novamente (de preferencia em janela anonima para evitar cache)
