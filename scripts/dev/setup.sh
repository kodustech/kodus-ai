#!/usr/bin/env bash

set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}🚀 Kodus AI - Setup Script${NC}"
echo -e "${BLUE}===============================${NC}"
echo ""

check_dependency() {
    if ! command -v $1 &> /dev/null; then
        echo -e "${RED}❌ $1 not found. Please install $1 first.${NC}"
        exit 1
    else
        echo -e "${GREEN}✅ $1 found${NC}"
    fi
}

generate_security_key() {
    openssl rand -base64 32 | tr -d '\n'
}

generate_hex_key() {
    openssl rand -hex 32
}

generate_webhook_token() {
    openssl rand -base64 32 | tr -d '=' | tr '/+' '_-'
}

upsert_env_if_missing_or_empty() {
    local key="$1"
    local value="$2"
    local quoted_value="\"$value\""
    local current_value=""

    if grep -q "^${key}=" .env; then
        current_value=$(grep "^${key}=" .env | head -n 1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
        if [ -z "$current_value" ]; then
            if [[ "$OSTYPE" == "darwin"* ]]; then
                sed -i '' "s|^${key}=.*|${key}=${quoted_value}|" .env
            else
                sed -i "s|^${key}=.*|${key}=${quoted_value}|" .env
            fi
        fi
    else
        echo "${key}=${quoted_value}" >> .env
    fi
}

echo -e "${YELLOW}🔍 Checking dependencies...${NC}"
check_dependency "node"
check_dependency "pnpm"
check_dependency "docker"
check_dependency "openssl"
echo ""

echo -e "${YELLOW}📦 Installing project dependencies...${NC}"
pnpm install
echo ""

echo -e "${YELLOW}🔧 Setting up environment file...${NC}"
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        echo -e "${GREEN}✅ .env file created from .env.example${NC}"
    else
        echo -e "${RED}❌ .env.example not found!${NC}"
        echo -e "${RED}Please create a .env.example file first.${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}⚠️  .env file already exists. Using existing file.${NC}"
fi

echo -e "${YELLOW}🔐 Generating security keys...${NC}"
JWT_SECRET=$(generate_security_key)
JWT_REFRESH_SECRET=$(generate_security_key)
API_JWT_SECRET=$(generate_security_key)
API_JWT_REFRESHSECRET=$(generate_security_key)

CODE_MANAGEMENT_SECRET=$(generate_hex_key)
CODE_MANAGEMENT_WEBHOOK_TOKEN=$(generate_webhook_token)
API_CRYPTO_KEY=$(generate_hex_key)
WEB_NEXTAUTH_SECRET=$(generate_security_key)

# Escape special characters for sed
JWT_SECRET_ESCAPED=$(echo "$JWT_SECRET" | sed 's/[[\.*^$()+?{|]/\\&/g')
JWT_REFRESH_SECRET_ESCAPED=$(echo "$JWT_REFRESH_SECRET" | sed 's/[[\.*^$()+?{|]/\\&/g')
API_JWT_SECRET_ESCAPED=$(echo "$API_JWT_SECRET" | sed 's/[[\.*^$()+?{|]/\\&/g')
API_JWT_REFRESHSECRET_ESCAPED=$(echo "$API_JWT_REFRESHSECRET" | sed 's/[[\.*^$()+?{|]/\\&/g')

CODE_MANAGEMENT_SECRET_ESCAPED=$(echo "$CODE_MANAGEMENT_SECRET" | sed 's/[[\.*^$()+?{|]/\\&/g')
CODE_MANAGEMENT_WEBHOOK_TOKEN_ESCAPED=$(echo "$CODE_MANAGEMENT_WEBHOOK_TOKEN" | sed 's/[[\.*^$()+?{|]/\\&/g')
API_CRYPTO_KEY_ESCAPED=$(echo "$API_CRYPTO_KEY" | sed 's/[[\.*^$()+?{|]/\\&/g')
API_PORT_ESCAPED="3001"

if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET_ESCAPED|" .env
    sed -i '' "s|JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$JWT_REFRESH_SECRET_ESCAPED|" .env
    sed -i '' "s|API_JWT_SECRET=.*|API_JWT_SECRET=$API_JWT_SECRET_ESCAPED|" .env
    sed -i '' "s|API_JWT_REFRESHSECRET=.*|API_JWT_REFRESHSECRET=$API_JWT_REFRESHSECRET_ESCAPED|" .env

    sed -i '' "s|CODE_MANAGEMENT_SECRET=.*|CODE_MANAGEMENT_SECRET=$CODE_MANAGEMENT_SECRET_ESCAPED|" .env
    sed -i '' "s|CODE_MANAGEMENT_WEBHOOK_TOKEN=.*|CODE_MANAGEMENT_WEBHOOK_TOKEN=$CODE_MANAGEMENT_WEBHOOK_TOKEN_ESCAPED|" .env
    sed -i '' "s|API_CRYPTO_KEY=.*|API_CRYPTO_KEY=$API_CRYPTO_KEY_ESCAPED|" .env
    sed -i '' "s|API_PORT=.*|API_PORT=$API_PORT_ESCAPED|" .env
else
    sed -i "s|JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET_ESCAPED|" .env
    sed -i "s|JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$JWT_REFRESH_SECRET_ESCAPED|" .env
    sed -i "s|API_JWT_SECRET=.*|API_JWT_SECRET=$API_JWT_SECRET_ESCAPED|" .env
    sed -i "s|API_JWT_REFRESHSECRET=.*|API_JWT_REFRESHSECRET=$API_JWT_REFRESHSECRET_ESCAPED|" .env

    sed -i "s|CODE_MANAGEMENT_SECRET=.*|CODE_MANAGEMENT_SECRET=$CODE_MANAGEMENT_SECRET_ESCAPED|" .env
    sed -i "s|CODE_MANAGEMENT_WEBHOOK_TOKEN=.*|CODE_MANAGEMENT_WEBHOOK_TOKEN=$CODE_MANAGEMENT_WEBHOOK_TOKEN_ESCAPED|" .env
    sed -i "s|API_CRYPTO_KEY=.*|API_CRYPTO_KEY=$API_CRYPTO_KEY_ESCAPED|" .env
    sed -i "s|API_PORT=.*|API_PORT=$API_PORT_ESCAPED|" .env
fi

upsert_env_if_missing_or_empty "WEB_NEXTAUTH_SECRET" "$WEB_NEXTAUTH_SECRET"
upsert_env_if_missing_or_empty "NEXTAUTH_URL" "http://localhost:3000"

echo -e "${GREEN}✅ Security keys generated and configured!${NC}"
echo ""

echo -e "${YELLOW}🐳 Setting up Docker networks...${NC}"
docker network create kodus-backend-services 2>/dev/null || echo -e "${YELLOW}ℹ️  Network kodus-backend-services already exists${NC}"
docker network create shared-network 2>/dev/null || echo -e "${YELLOW}ℹ️  Network shared-network already exists${NC}"
echo -e "${GREEN}✅ Docker networks configured!${NC}"
echo ""

echo -e "${GREEN}🎉 Setup completed successfully!${NC}"
echo ""
echo -e "${BLUE}📋 Next steps:${NC}"
echo -e "${BLUE}1.${NC} Configure your LLM API keys in the .env file:"
echo -e "   ${YELLOW}API_OPEN_AI_API_KEY=your_api_key_here${NC}"
echo ""
echo -e "${BLUE}2.${NC} Start the services:"
echo -e "   ${YELLOW}pnpm run docker:start${NC}"
echo ""
echo -e "${BLUE}3.${NC} Create public tunnel for webhooks (required for GitHub integration):"
echo -e "   ${YELLOW}pnpm run tunnel${NC}"
echo -e "   ${YELLOW}   This will create a public URL and update your .env file${NC}"
echo -e "   ${YELLOW}   Keep this running in a separate terminal${NC}"
echo ""
echo -e "${BLUE}4.${NC} Migrations + seed run automatically with docker:start"
echo ""
echo -e "${BLUE}5.${NC} To verify everything is working:"
echo -e "   ${YELLOW}pnpm run dev:health-check${NC}"
echo ""
echo -e "${BLUE}6.${NC} To access the API:"
echo -e "   ${YELLOW}http://localhost:3001${NC}"
echo -e "${BLUE}7.${NC} To access the Web app:"
echo -e "   ${YELLOW}http://localhost:3000${NC}"
echo ""
echo -e "${BLUE}💡 Pro tip:${NC}"
echo -e "   ${YELLOW}pnpm run dev:with-tunnel${NC} - Start Docker and tunnel together"
