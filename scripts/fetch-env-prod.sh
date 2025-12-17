#!/bin/bash

ENVIRONMENT=$1

# Lista de todas as chaves que você precisa
KEYS=(
    "/prod/kodus-orchestrator/API_HOST"
    "/prod/kodus-orchestrator/API_PORT"
    "/prod/kodus-orchestrator/API_RATE_MAX_REQUEST"
    "/prod/kodus-orchestrator/API_RATE_INTERVAL"

    "/prod/kodus-orchestrator/API_JWT_EXPIRES_IN"
    "/prod/kodus-orchestrator/API_JWT_SECRET"
    "/prod/kodus-orchestrator/API_JWT_REFRESHSECRET"
    "/prod/kodus-orchestrator/API_JWT_REFRESH_EXPIRES_IN"

    "/prod/kodus-orchestrator/API_PG_DB_HOST"
    "/prod/kodus-orchestrator/API_PG_DB_PORT"
    "/prod/kodus-orchestrator/API_PG_DB_USERNAME"
    "/prod/kodus-orchestrator/API_PG_DB_PASSWORD"
    "/prod/kodus-orchestrator/API_PG_DB_DATABASE"

    "/prod/kodus-orchestrator/API_MG_DB_HOST"
    "/prod/kodus-orchestrator/API_MG_DB_PORT"
    "/prod/kodus-orchestrator/API_MG_DB_USERNAME"
    "/prod/kodus-orchestrator/API_MG_DB_PASSWORD"
    "/prod/kodus-orchestrator/API_MG_DB_DATABASE"
    "/prod/kodus-orchestrator/API_MG_DB_PRODUCTION_CONFIG"

    "/prod/kodus-orchestrator/API_OPEN_AI_API_KEY"
    "/prod/kodus-orchestrator/API_RABBITMQ_URI"
    "/prod/kodus-orchestrator/API_RABBITMQ_ENABLED"

    "/prod/kodus-orchestrator/GLOBAL_JIRA_CLIENT_ID"
    "/prod/kodus-orchestrator/GLOBAL_JIRA_REDIRECT_URI"
    "/prod/kodus-orchestrator/API_JIRA_CLIENT_SECRET"
    "/prod/kodus-orchestrator/API_JIRA_BASE_URL"
    "/prod/kodus-orchestrator/API_JIRA_MID_URL"
    "/prod/kodus-orchestrator/API_JIRA_OAUTH_TOKEN_URL"
    "/prod/kodus-orchestrator/API_JIRA_GET_PERSONAL_PROFILE_URL"
    "/prod/kodus-orchestrator/API_JIRA_OAUTH_API_TOKEN_URL"
    "/prod/kodus-orchestrator/API_JIRA_URL_API_VERSION_1"
    "/prod/kodus-orchestrator/JIRA_URL_TO_WEBHOOK"

    "/prod/kodus-orchestrator/API_GITHUB_APP_ID"
    "/prod/kodus-orchestrator/GLOBAL_GITHUB_CLIENT_ID"
    "/prod/kodus-orchestrator/API_GITHUB_CLIENT_SECRET"
    "/prod/kodus-orchestrator/API_GITHUB_PRIVATE_KEY"
    "/prod/kodus-orchestrator/GLOBAL_GITHUB_REDIRECT_URI"

    "/prod/kodus-orchestrator/GLOBAL_GITLAB_CLIENT_ID"
    "/prod/kodus-orchestrator/GLOBAL_GITLAB_CLIENT_SECRET"
    "/prod/kodus-orchestrator/GLOBAL_GITLAB_REDIRECT_URL"
    "/prod/kodus-orchestrator/API_GITLAB_TOKEN_URL"

    "/prod/kodus-orchestrator/API_GITLAB_CODE_MANAGEMENT_WEBHOOK"
    "/prod/kodus-orchestrator/API_GITHUB_CODE_MANAGEMENT_WEBHOOK"

    "/prod/kodus-orchestrator/API_SLACK_CLIENT_ID"
    "/prod/kodus-orchestrator/API_SLACK_CLIENT_SECRET"
    "/prod/kodus-orchestrator/API_SLACK_SIGNING_SECRET"
    "/prod/kodus-orchestrator/API_SLACK_APP_TOKEN"
    "/prod/kodus-orchestrator/API_SLACK_BOT_TOKEN"
    "/prod/kodus-orchestrator/API_SLACK_URL_HEALTH"
    "/prod/kodus-orchestrator/API_SLACK_BOT_DIAGNOSIS_URL"

    "/prod/kodus-orchestrator/LANGCHAIN_TRACING_V2"
    "/prod/kodus-orchestrator/LANGCHAIN_ENDPOINT"
    "/prod/kodus-orchestrator/LANGCHAIN_HUB_API_URL"
    "/prod/kodus-orchestrator/LANGCHAIN_API_KEY"
    "/prod/kodus-orchestrator/LANGCHAIN_PROJECT"
    "/prod/kodus-orchestrator/LANGCHAIN_CALLBACKS_BACKGROUND"

    "/prod/kodus-orchestrator/API_SENTRY_DNS"

    "/prod/kodus-orchestrator/API_CRON_AUTOMATION_INTERACTION_MONITOR"
    "/prod/kodus-orchestrator/API_CRON_AUTOMATION_TEAM_PROGRESS_TRACKER"
    "/prod/kodus-orchestrator/API_CRON_METRICS"
    "/prod/kodus-orchestrator/API_CRON_AUTOMATION_ISSUES_DETAILS"
    "/prod/kodus-orchestrator/CRON_TEAM_ARTIFACTS"
    "/prod/kodus-orchestrator/API_CRON_TEAM_ARTIFACTS_WEEKLY"
    "/prod/kodus-orchestrator/API_CRON_TEAM_ARTIFACTS_DAILY"
    "/prod/kodus-orchestrator/API_CRON_COMPILE_SPRINT"
    "/prod/kodus-orchestrator/API_CRON_SPRINT_RETRO"
    "/prod/kodus-orchestrator/API_CRON_ORGANIZATION_METRICS"
    "/prod/kodus-orchestrator/API_CRON_ORGANIZATION_ARTIFACTS_WEEKLY"
    "/prod/kodus-orchestrator/API_CRON_ORGANIZATION_ARTIFACTS_DAILY"
    "/prod/kodus-orchestrator/API_CRON_ENRICH_TEAM_ARTIFACTS_WEEKLY"
    "/prod/kodus-orchestrator/API_CRON_AUTOMATION_EXECUTIVE_CHECKIN"
    "/prod/kodus-orchestrator/API_CRON_SYNC_CODE_REVIEW_REACTIONS"
    "/prod/kodus-orchestrator/API_CRON_KODY_LEARNING"
    "/prod/kodus-orchestrator/API_CRON_CHECK_IF_PR_SHOULD_BE_APPROVED"

    "/prod/kodus-orchestrator/KODUS_SERVICE_TEAMS"
    "/prod/kodus-orchestrator/GLOBAL_KODUS_SERVICE_SLACK"

    "/prod/kodus-orchestrator/KODUS_SERVICE_AZURE_BOARDS"
    "/prod/kodus-orchestrator/GLOBAL_KODUS_SERVICE_DISCORD"
    "/prod/kodus-orchestrator/KODUS_SERVICE_AZURE_REPOS"
    "/prod/kodus-orchestrator/API_CRON_AUTOMATION_DAILY_CHECKIN"

    "/prod/kodus-orchestrator/API_MAILSEND_API_TOKEN"
    "/prod/kodus-orchestrator/API_USER_INVITE_BASE_URL"

    "/prod/kodus-orchestrator/API_AWS_REGION"
    "/prod/kodus-orchestrator/API_AWS_USERNAME"
    "/prod/kodus-orchestrator/API_AWS_PASSWORD"
    "/prod/kodus-orchestrator/API_AWS_BUCKET_NAME_ASSISTANT"

    "/prod/kodus-orchestrator/API_GOOGLE_AI_API_KEY"
    "/prod/kodus-orchestrator/API_ANTHROPIC_API_KEY"
    "/prod/kodus-orchestrator/COHERE_API_KEY"
    "/prod/kodus-orchestrator/API_FIREWORKS_API_KEY"

    "/prod/kodus-orchestrator/API_SIGNUP_NOTIFICATION_WEBHOOK"
    "/prod/kodus-orchestrator/API_CRYPTO_KEY"

    "/prod/kodus-orchestrator/TAVILY_API_KEY"
    "/prod/kodus-orchestrator/API_SEGMENT_KEY"

    "/prod/kodus-orchestrator/API_VERTEX_AI_API_KEY"
    "/prod/kodus-orchestrator/TOGETHER_AI_API_KEY"
    "/prod/kodus-orchestrator/API_NOVITA_AI_API_KEY"

    "/prod/kodus-orchestrator/GLOBAL_BITBUCKET_CODE_MANAGEMENT_WEBHOOK"

    "/prod/kodus-orchestrator/API_ENABLE_CODE_REVIEW_AST"

    "/prod/kodus-orchestrator/CODE_MANAGEMENT_SECRET"
    "/prod/kodus-orchestrator/CODE_MANAGEMENT_WEBHOOK_TOKEN"

    "/prod/kodus-orchestrator/GLOBAL_AZURE_REPOS_CODE_MANAGEMENT_WEBHOOK"
    "/prod/kodus-orchestrator/GLOBAL_KODUS_SERVICE_BILLING"

    "/prod/kodus-orchestrator/API_POSTHOG_KEY"

    "/prod/kodus-orchestrator/API_SERVICE_AST_URL"

    "/prod/kodus-orchestrator/API_MCP_SERVER_ENABLED"
    "/prod/kodus-orchestrator/API_KODUS_SERVICE_MCP_MANAGER"
    "/prod/kodus-orchestrator/API_KODUS_MCP_SERVER_URL"

    "/prod/kodus-orchestrator/API_OPENROUTER_KEY"

    "/prod/kodus-orchestrator/API_URL"
    "/prod/kodus-orchestrator/API_FRONTEND_URL"

    "/prod/kodus-orchestrator/API_GROQ_BASE_URL"
    "/prod/kodus-orchestrator/API_GROQ_API_KEY"
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
