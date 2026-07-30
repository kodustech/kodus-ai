#!/usr/bin/env bash

ENVIRONMENT=$1

# Lista de todas as chaves que você precisa
KEYS=(
    "/qa/kodus-orchestrator/API_HOST"
    "/qa/kodus-orchestrator/API_PORT"
    "/qa/kodus-orchestrator/API_RATE_MAX_REQUEST"
    "/qa/kodus-orchestrator/API_RATE_INTERVAL"

    "/qa/kodus-orchestrator/API_JWT_EXPIRES_IN"
    "/qa/kodus-orchestrator/API_JWT_SECRET"
    "/qa/kodus-orchestrator/API_JWT_REFRESH_EXPIRES_IN"

    "/qa/kodus-orchestrator/API_PG_DB_HOST"
    "/qa/kodus-orchestrator/API_PG_DB_PORT"
    "/qa/kodus-orchestrator/API_PG_DB_USERNAME"
    "/qa/kodus-orchestrator/API_PG_DB_PASSWORD"
    "/qa/kodus-orchestrator/API_PG_DB_DATABASE"

    "/qa/kodus-orchestrator/API_MG_DB_HOST"
    "/qa/kodus-orchestrator/API_MG_DB_PORT"
    "/qa/kodus-orchestrator/API_MG_DB_USERNAME"
    "/qa/kodus-orchestrator/API_MG_DB_PASSWORD"
    "/qa/kodus-orchestrator/API_MG_DB_DATABASE"
    "/qa/kodus-orchestrator/API_MG_DB_PRODUCTION_CONFIG"

    "/qa/kodus-orchestrator/API_OPEN_AI_API_KEY"
    "/qa/kodus-orchestrator/API_RABBITMQ_URI"
    "/qa/kodus-orchestrator/API_RABBITMQ_ENABLED"

    "/qa/kodus-orchestrator/API_GITHUB_APP_ID"
    "/qa/kodus-orchestrator/GLOBAL_GITHUB_CLIENT_ID"
    "/qa/kodus-orchestrator/API_GITHUB_CLIENT_SECRET"
    "/qa/kodus-orchestrator/API_GITHUB_PRIVATE_KEY"
    "/qa/kodus-orchestrator/GLOBAL_GITHUB_REDIRECT_URI"

    "/qa/kodus-orchestrator/GLOBAL_GITLAB_CLIENT_ID"
    "/qa/kodus-orchestrator/GLOBAL_GITLAB_CLIENT_SECRET"
    "/qa/kodus-orchestrator/GLOBAL_GITLAB_REDIRECT_URL"
    "/qa/kodus-orchestrator/API_GITLAB_TOKEN_URL"

    "/qa/kodus-orchestrator/API_GITLAB_CODE_MANAGEMENT_WEBHOOK"
    "/qa/kodus-orchestrator/API_GITHUB_CODE_MANAGEMENT_WEBHOOK"

    "/qa/kodus-orchestrator/LANGFUSE_TRACING"
    "/qa/kodus-orchestrator/LANGFUSE_PUBLIC_KEY"
    "/qa/kodus-orchestrator/LANGFUSE_SECRET_KEY"
    "/qa/kodus-orchestrator/LANGFUSE_BASE_URL"
    "/qa/kodus-orchestrator/LANGFUSE_ENVIRONMENT"

    "/qa/kodus-orchestrator/API_BETTERSTACK_DSN"

    "/qa/kodus-orchestrator/API_CRON_SYNC_CODE_REVIEW_REACTIONS"
    "/qa/kodus-orchestrator/API_CRON_KODY_LEARNING"
    "/qa/kodus-orchestrator/API_CRON_CHECK_IF_PR_SHOULD_BE_APPROVED"
    "/qa/kodus-orchestrator/API_CRON_SSO_TEST_SESSION_CLEANUP"
    "/qa/kodus-orchestrator/API_CRON_WEEKLY_RECAP"

    "/qa/kodus-orchestrator/KODUS_SERVICE_TEAMS"

    "/qa/kodus-orchestrator/KODUS_SERVICE_AZURE_REPOS"

    "/qa/kodus-orchestrator/RESEND_API_KEY"
    "/qa/kodus-orchestrator/RESEND_WEBHOOK_SECRET"
    "/qa/kodus-orchestrator/API_USER_INVITE_BASE_URL"

    "/qa/kodus-orchestrator/API_AWS_REGION"
    "/qa/kodus-orchestrator/API_AWS_USERNAME"
    "/qa/kodus-orchestrator/API_AWS_PASSWORD"
    "/qa/kodus-orchestrator/API_AWS_BUCKET_NAME_ASSISTANT"

    "/qa/kodus-orchestrator/API_GOOGLE_AI_API_KEY"
    "/qa/kodus-orchestrator/API_ANTHROPIC_API_KEY"

    "/qa/kodus-orchestrator/N8N_WEBHOOK_URL"
    "/qa/kodus-orchestrator/API_SIGNUP_NOTIFICATION_WEBHOOK"
    "/qa/kodus-orchestrator/API_CRYPTO_KEY"

    "/qa/kodus-orchestrator/API_SEGMENT_KEY"

    "/qa/kodus-orchestrator/API_VERTEX_AI_API_KEY"
    "/qa/kodus-orchestrator/API_VERTEX_AI_LOCATION"
    "/qa/kodus-orchestrator/API_GOOGLE_AI_PROVIDER"

    "/qa/kodus-orchestrator/API_NOVITA_AI_API_KEY"

    "/qa/kodus-orchestrator/GLOBAL_BITBUCKET_CODE_MANAGEMENT_WEBHOOK"
    "/qa/kodus-orchestrator/BITBUCKET_RATE_GATE_MIN_INTERVAL_MS"

    "/qa/kodus-orchestrator/CODE_MANAGEMENT_SECRET"
    "/qa/kodus-orchestrator/CODE_MANAGEMENT_WEBHOOK_TOKEN"

    "/qa/kodus-orchestrator/GLOBAL_AZURE_REPOS_CODE_MANAGEMENT_WEBHOOK"

    "/qa/kodus-orchestrator/API_POSTHOG_KEY"

    "/qa/kodus-orchestrator/API_MCP_SERVER_ENABLED"
    "/qa/kodus-orchestrator/API_KODUS_SERVICE_MCP_MANAGER"
    "/qa/kodus-orchestrator/API_KODUS_MCP_SERVER_URL"

    "/qa/kodus-orchestrator/API_OPENROUTER_KEY"
    "/qa/kodus-orchestrator/API_LLM_TEMPERATURE_OVERRIDE"

    "/qa/kodus-orchestrator/API_URL"
    "/qa/kodus-orchestrator/API_FRONTEND_URL"

    "/qa/kodus-orchestrator/API_GROQ_BASE_URL"
    "/qa/kodus-orchestrator/API_GROQ_API_KEY"

    "/qa/kodus-orchestrator/GLOBAL_KODUS_SERVICE_BILLING"

    "/qa/kodus-orchestrator/API_WEBHOOKS_PORT"

    "/qa/kodus-orchestrator/API_ECS_AGENT_URI"
    "/qa/kodus-orchestrator/API_WORKER_DRAIN_TIMEOUT_MS"

    "/qa/kodus-orchestrator/API_CEREBRAS_BASE_URL"
    "/qa/kodus-orchestrator/API_CEREBRAS_API_KEY"

    "/qa/kodus-orchestrator/API_MORPHLLM_API_KEY"

    "/qa/kodus-orchestrator/API_E2B_KEY"
    "/qa/kodus-orchestrator/API_E2B_TEMPLATE_ID"

    "/qa/kodus-orchestrator/API_BETTERSTACK_API_TOKEN"
    "/qa/kodus-orchestrator/API_BETTERSTACK_HEARTBEAT_ERROR_RATE_URL"
    "/qa/kodus-orchestrator/API_BETTERSTACK_HEARTBEAT_REVIEW_MONITOR_URL"
    "/qa/kodus-orchestrator/API_BETTERSTACK_HEARTBEAT_OUTBOX_URL"
    "/qa/kodus-orchestrator/API_BETTERSTACK_HEARTBEAT_WEBHOOK_URL"

    "/qa/kodus-orchestrator/API_EXA_KEY"

    "/qa/kodus-orchestrator/WEB_HOSTNAME_HELPDESK"
    "/qa/kodus-orchestrator/WEB_PORT_HELPDESK"
    "/qa/kodus-orchestrator/API_JWT_PRIVATE_KEY"

    "/qa/kodus-orchestrator/API_BILLING_WEBHOOK_SECRET"
)

# Lista de todas as chaves que você precisa

ENV_FILE=".env.$ENVIRONMENT"

# Limpe o arquivo .env existente ou crie um novo
> $ENV_FILE

# Loop para buscar cada parâmetro
for KEY in "${KEYS[@]}"; do
  # Tenta obter o parâmetro, redirecionando mensagens de erro para /dev/null
  VALUE=$(aws ssm get-parameter --name "$KEY" --with-decryption --query "Parameter.Value" --output text 2>/dev/null)

  if [ -z "$VALUE" ] || [[ "$VALUE" == "ParameterNotFound" ]]; then
    # Se o comando não retornar valor, registra um aviso (pode ser logado ou mostrado no stderr)
    echo "WARNING: Parâmetro $KEY não encontrado." >&2
  else
    # Remove o caminho e escreve no arquivo .env
    echo "${KEY##*/}=$VALUE" >> "$ENV_FILE"
  fi
done

# API_JWT_REFRESH_SECRET: o código lê o nome com underscore
# (jwt.config.loader.ts), mas o parâmetro no SSM pode ainda usar o typo
# legado API_JWT_REFRESHSECRET. Tenta o nome canônico, cai pro legado,
# e sempre escreve a chave canônica — o .env precisa bater com o código.
REFRESH_SECRET=$(aws ssm get-parameter --name "/qa/kodus-orchestrator/API_JWT_REFRESH_SECRET" --with-decryption --query "Parameter.Value" --output text 2>/dev/null)
if [ -z "$REFRESH_SECRET" ] || [[ "$REFRESH_SECRET" == "ParameterNotFound" ]]; then
  REFRESH_SECRET=$(aws ssm get-parameter --name "/qa/kodus-orchestrator/API_JWT_REFRESHSECRET" --with-decryption --query "Parameter.Value" --output text 2>/dev/null)
fi
if [ -n "$REFRESH_SECRET" ] && [[ "$REFRESH_SECRET" != "ParameterNotFound" ]]; then
  echo "API_JWT_REFRESH_SECRET=$REFRESH_SECRET" >> "$ENV_FILE"
else
  echo "WARNING: API_JWT_REFRESH_SECRET não encontrado (nem o legado API_JWT_REFRESHSECRET)." >&2
fi
