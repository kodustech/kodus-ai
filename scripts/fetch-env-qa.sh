#!/bin/bash

ENVIRONMENT=$1

# Lista de todas as chaves que você precisa
KEYS=(
    "/qa/kodus-orchestrator/API_HOST"
    "/qa/kodus-orchestrator/API_PORT"
    "/qa/kodus-orchestrator/API_RATE_MAX_REQUEST"
    "/qa/kodus-orchestrator/API_RATE_INTERVAL"

    "/qa/kodus-orchestrator/API_JWT_EXPIRES_IN"
    "/qa/kodus-orchestrator/API_JWT_SECRET"
    "/qa/kodus-orchestrator/API_JWT_REFRESHSECRET"
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

    "/qa/kodus-orchestrator/GLOBAL_JIRA_CLIENT_ID"
    "/qa/kodus-orchestrator/GLOBAL_JIRA_REDIRECT_URI"
    "/qa/kodus-orchestrator/API_JIRA_CLIENT_SECRET"
    "/qa/kodus-orchestrator/API_JIRA_BASE_URL"
    "/qa/kodus-orchestrator/API_JIRA_MID_URL"
    "/qa/kodus-orchestrator/API_JIRA_OAUTH_TOKEN_URL"
    "/qa/kodus-orchestrator/API_JIRA_GET_PERSONAL_PROFILE_URL"
    "/qa/kodus-orchestrator/API_JIRA_OAUTH_API_TOKEN_URL"
    "/qa/kodus-orchestrator/API_JIRA_URL_API_VERSION_1"
    "/qa/kodus-orchestrator/JIRA_URL_TO_WEBHOOK"

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

    "/qa/kodus-orchestrator/API_SLACK_CLIENT_ID"
    "/qa/kodus-orchestrator/API_SLACK_CLIENT_SECRET"
    "/qa/kodus-orchestrator/API_SLACK_SIGNING_SECRET"
    "/qa/kodus-orchestrator/API_SLACK_APP_TOKEN"
    "/qa/kodus-orchestrator/API_SLACK_BOT_TOKEN"
    "/qa/kodus-orchestrator/API_SLACK_URL_HEALTH"
    "/qa/kodus-orchestrator/API_SLACK_BOT_DIAGNOSIS_URL"

    "/qa/kodus-orchestrator/LANGCHAIN_TRACING_V2"
    "/qa/kodus-orchestrator/LANGCHAIN_ENDPOINT"
    "/qa/kodus-orchestrator/LANGCHAIN_HUB_API_URL"
    "/qa/kodus-orchestrator/LANGCHAIN_API_KEY"
    "/qa/kodus-orchestrator/LANGCHAIN_PROJECT"
    "/qa/kodus-orchestrator/LANGCHAIN_CALLBACKS_BACKGROUND"

    "/qa/kodus-orchestrator/API_SENTRY_DNS"

    "/qa/kodus-orchestrator/API_CRON_AUTOMATION_INTERACTION_MONITOR"
    "/qa/kodus-orchestrator/API_CRON_AUTOMATION_TEAM_PROGRESS_TRACKER"
    "/qa/kodus-orchestrator/API_CRON_METRICS"
    "/qa/kodus-orchestrator/API_CRON_AUTOMATION_ISSUES_DETAILS"
    "/qa/kodus-orchestrator/CRON_TEAM_ARTIFACTS"
    "/qa/kodus-orchestrator/API_CRON_TEAM_ARTIFACTS_WEEKLY"
    "/qa/kodus-orchestrator/API_CRON_TEAM_ARTIFACTS_DAILY"
    "/qa/kodus-orchestrator/API_CRON_COMPILE_SPRINT"
    "/qa/kodus-orchestrator/API_CRON_SPRINT_RETRO"
    "/qa/kodus-orchestrator/API_CRON_ORGANIZATION_METRICS"
    "/qa/kodus-orchestrator/API_CRON_ORGANIZATION_ARTIFACTS_WEEKLY"
    "/qa/kodus-orchestrator/API_CRON_ORGANIZATION_ARTIFACTS_DAILY"
    "/qa/kodus-orchestrator/API_CRON_ENRICH_TEAM_ARTIFACTS_WEEKLY"
    "/qa/kodus-orchestrator/API_CRON_AUTOMATION_EXECUTIVE_CHECKIN"
    "/qa/kodus-orchestrator/API_CRON_SYNC_CODE_REVIEW_REACTIONS"
    "/qa/kodus-orchestrator/API_CRON_KODY_LEARNING"
    "/qa/kodus-orchestrator/API_CRON_CHECK_IF_PR_SHOULD_BE_APPROVED"

    "/qa/kodus-orchestrator/KODUS_SERVICE_TEAMS"
    "/qa/kodus-orchestrator/GLOBAL_KODUS_SERVICE_SLACK"

    "/qa/kodus-orchestrator/KODUS_SERVICE_AZURE_BOARDS"
    "/qa/kodus-orchestrator/GLOBAL_KODUS_SERVICE_DISCORD"
    "/qa/kodus-orchestrator/KODUS_SERVICE_AZURE_REPOS"
    "/qa/kodus-orchestrator/API_CRON_AUTOMATION_DAILY_CHECKIN"

    "/qa/kodus-orchestrator/API_MAILSEND_API_TOKEN"
    "/qa/kodus-orchestrator/API_USER_INVITE_BASE_URL"

    "/qa/kodus-orchestrator/API_AWS_REGION"
    "/qa/kodus-orchestrator/API_AWS_USERNAME"
    "/qa/kodus-orchestrator/API_AWS_PASSWORD"
    "/qa/kodus-orchestrator/API_AWS_BUCKET_NAME_ASSISTANT"

    "/qa/kodus-orchestrator/API_GOOGLE_AI_API_KEY"
    "/qa/kodus-orchestrator/API_ANTHROPIC_API_KEY"
    "/qa/kodus-orchestrator/COHERE_API_KEY"
    "/qa/kodus-orchestrator/API_FIREWORKS_API_KEY"

    "/qa/kodus-orchestrator/API_SIGNUP_NOTIFICATION_WEBHOOK"
    "/qa/kodus-orchestrator/API_CRYPTO_KEY"

    "/qa/kodus-orchestrator/TAVILY_API_KEY"
    "/qa/kodus-orchestrator/API_SEGMENT_KEY"

    "/qa/kodus-orchestrator/API_VERTEX_AI_API_KEY"
    "/qa/kodus-orchestrator/TOGETHER_AI_API_KEY"
    "/qa/kodus-orchestrator/API_NOVITA_AI_API_KEY"

    "/qa/kodus-orchestrator/GLOBAL_BITBUCKET_CODE_MANAGEMENT_WEBHOOK"

    "/qa/kodus-orchestrator/API_ENABLE_CODE_REVIEW_AST"

    "/qa/kodus-orchestrator/CODE_MANAGEMENT_SECRET"
    "/qa/kodus-orchestrator/CODE_MANAGEMENT_WEBHOOK_TOKEN"

    "/qa/kodus-orchestrator/GLOBAL_AZURE_REPOS_CODE_MANAGEMENT_WEBHOOK"
    "/qa/kodus-orchestrator/GLOBAL_KODUS_SERVICE_BILLING"

    "/qa/kodus-orchestrator/API_POSTHOG_KEY"

    "/qa/kodus-orchestrator/API_SERVICE_AST_URL"

    "/qa/kodus-orchestrator/API_MCP_SERVER_ENABLED"
    "/qa/kodus-orchestrator/API_KODUS_SERVICE_MCP_MANAGER"
    "/qa/kodus-orchestrator/API_KODUS_MCP_SERVER_URL"

    "/qa/kodus-orchestrator/API_OPENROUTER_KEY"

    "/qa/kodus-orchestrator/API_URL"
    "/qa/kodus-orchestrator/API_FRONTEND_URL"

    "/qa/kodus-orchestrator/API_GROQ_BASE_URL"
    "/qa/kodus-orchestrator/API_GROQ_API_KEY"
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
