#!/usr/bin/env bash

echo "🚀 Setting up development environment for Kodus Web..."

# Check if .env.example exists
if [ ! -f ".env.example" ]; then
    echo "❌ .env.example file not found. Please create it first."
    exit 1
fi

# Check if .env already exists
if [ -f ".env" ]; then
    echo "⚠️  .env file already exists. Do you want to overwrite it? (y/N)"
    read -r response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        echo "⏭️  Skipping .env setup. Using existing .env file."
        echo ""
        echo "📋 Next steps:"
        echo "   1. Review the .env file and fill in any additional values you need"
        echo "   2. Run 'pnpm install' to install dependencies"
        echo "   3. Run 'pnpm docker:start' to start the Docker services"
        echo ""
        echo "⚠️  Note: Some integrations (GitHub, GitLab, Slack, etc.) require additional configuration"
        echo "   Check the documentation for setup instructions."
        exit 0
    fi
fi

# Generate secure secrets
echo "🔐 Generating secure secrets..."
NEXTAUTH_SECRET=$(openssl rand -base64 32)

# Ask about API JWT secret
echo ""
echo "🤔 Do you already have the API configured with a JWT secret?"
echo "   1) Yes, I have the API .env file (paste the key)"
echo "   2) No, I'll set up the API later (generate new key)"
echo "   3) Skip JWT setup for now"
echo ""
read -p "Choose an option (1/2/3): " jwt_option

case $jwt_option in
    1)
        echo ""
        echo "📋 Please paste the API_JWT_SECRET from your API .env file:"
        read -p "API_JWT_SECRET: " API_JWT_SECRET
        if [ -n "$API_JWT_SECRET" ]; then
            JWT_SECRET="$API_JWT_SECRET"
            echo "✅ Using existing API JWT secret"
        else
            echo "⚠️  No key provided, generating new one..."
            JWT_SECRET=$(openssl rand -base64 32)
        fi
        ;;
    2)
        echo "🆕 Generating new JWT secret for API..."
        JWT_SECRET=$(openssl rand -base64 32)
        ;;
    3)
        echo "⏭️  Skipping JWT setup..."
        JWT_SECRET=""
        ;;
    *)
        echo "❌ Invalid option, generating new JWT secret..."
        JWT_SECRET=$(openssl rand -base64 32)
        ;;
esac

# Copy .env.example to .env
echo "📝 Copying .env.example to .env..."
cp .env.example .env

# Replace the specific keys that need to be generated using awk
echo "🔑 Updating generated secrets in .env..."
if [ -n "$JWT_SECRET" ]; then
    awk -v nextauth="$NEXTAUTH_SECRET" -v jwt="$JWT_SECRET" '
        /^WEB_NEXTAUTH_SECRET=/ { print "WEB_NEXTAUTH_SECRET=\"" nextauth "\""; next }
        { print }
    ' .env > .env.tmp && mv .env.tmp .env
else
    awk -v nextauth="$NEXTAUTH_SECRET" '
        /^WEB_NEXTAUTH_SECRET=/ { print "WEB_NEXTAUTH_SECRET=\"" nextauth "\""; next }
        { print }
    ' .env > .env.tmp && mv .env.tmp .env
fi

echo "✅ .env file created successfully from .env.example!"
echo ""
echo "🔑 Generated secrets:"
echo "   WEB_NEXTAUTH_SECRET: $NEXTAUTH_SECRET"
if [ -n "$JWT_SECRET" ]; then
    echo ""
    if [ "$jwt_option" = "1" ]; then
        echo "✅ JWT secret synchronized with your API"
    else
        echo "⚠️  IMPORTANT: Copy this JWT secret to your API .env file:"
        echo "   API_JWT_SECRET=$JWT_SECRET"
        echo ""
        echo "📁 Common API folder locations:"
        echo "   - ../api/.env"
        echo "   - ../backend/.env"
        echo "   - ../kodus-api/.env"
        echo "   - ../orchestrator/.env"
        echo "   - Or wherever your API .env is located"
    fi
else
    echo "   WEB_JWT_SECRET_KEY: (not set - skipped)"
fi
echo ""
echo "📋 Next steps:"
if [ -n "$JWT_SECRET" ] && [ "$jwt_option" != "1" ]; then
    echo "   1. Copy the JWT secret above to your API .env file"
    echo "   2. Review the .env file and fill in any additional values you need"
    echo "   3. Run 'pnpm install' to install dependencies"
    echo "   4. Run 'pnpm docker:start' to start the Docker services"
else
    echo "   1. Review the .env file and fill in any additional values you need"
    echo "   2. Run 'pnpm install' to install dependencies"
    echo "   3. Run 'pnpm docker:start' to start the Docker services"
fi
echo ""
echo "⚠️  Note: Some integrations (GitHub, GitLab, Slack, etc.) require additional configuration"
echo "   Check the documentation for setup instructions."
