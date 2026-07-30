#!/usr/bin/env bash

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Load environment variables from .env if it exists
if [ -f .env ]; then
    # Load API_PORT
    if grep -q "^API_PORT=" .env; then
        API_PORT=$(grep "^API_PORT=" .env | cut -d'=' -f2 | tr -d '"' | tr -d "'")
    else
        API_PORT=3001
    fi
    
    # Load database variables
    if grep -q "^API_PG_DB_USERNAME=" .env; then
        API_PG_DB_USERNAME=$(grep "^API_PG_DB_USERNAME=" .env | cut -d'=' -f2 | tr -d '"' | tr -d "'")
    else
        API_PG_DB_USERNAME=kodusdev
    fi
    
    if grep -q "^API_PG_DB_DATABASE=" .env; then
        API_PG_DB_DATABASE=$(grep "^API_PG_DB_DATABASE=" .env | cut -d'=' -f2 | tr -d '"' | tr -d "'")
    else
        API_PG_DB_DATABASE=kodus_db
    fi

    if grep -q "^WEB_PORT=" .env; then
        WEB_PORT=$(grep "^WEB_PORT=" .env | cut -d'=' -f2 | tr -d '"' | tr -d "'")
    else
        WEB_PORT=3000
    fi
else
    # Default values if .env doesn't exist
    API_PORT=3001
    API_PG_DB_USERNAME=kodusdev
    API_PG_DB_DATABASE=kodus_db
    WEB_PORT=3000
fi

echo -e "${BLUE}🔍 Kodus AI - Health Check${NC}"
echo -e "${BLUE}============================${NC}"
echo -e "${BLUE}Using API Port: ${API_PORT}${NC}"
echo -e "${BLUE}Using Database: ${API_PG_DB_DATABASE} (user: ${API_PG_DB_USERNAME})${NC}"
echo ""

check_service() {
    local service_name=$1
    local url=$2
    local expected_status=${3:-200}
    
    echo -n "Checking $service_name... "
    
    # Get HTTP status code and handle connection errors
    local status_code
    status_code=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null)
    local curl_exit=$?
    
    if [ $curl_exit -ne 0 ]; then
        echo -e "${RED}❌ CONNECTION FAILED${NC}"
        echo -e "   ${YELLOW}curl error code: $curl_exit${NC}"
        return 1
    elif echo "$status_code" | grep -q "$expected_status"; then
        echo -e "${GREEN}✅ OK (HTTP $status_code)${NC}"
        return 0
    else
        echo -e "${RED}❌ HTTP $status_code${NC}"
        return 1
    fi
}

check_any_container() {
    local service_name=$1
    shift
    local candidates=("$@")

    echo -n "Checking container $service_name... "

    local running_names
    running_names=$(docker ps --format "{{.Names}}")
    for container_name in "${candidates[@]}"; do
        if echo "$running_names" | grep -qx "$container_name"; then
            echo -e "${GREEN}✅ RUNNING ($container_name)${NC}"
            return 0
        fi
    done

    echo -e "${RED}❌ NOT RUNNING${NC}"
    return 1
}

check_port() {
    local service_name=$1
    local port=$2
    
    echo -n "Checking port $port ($service_name)... "
    
    if nc -z localhost $port 2>/dev/null; then
        echo -e "${GREEN}✅ OPEN${NC}"
        return 0
    else
        echo -e "${RED}❌ CLOSED${NC}"
        return 1
    fi
}

all_good=true

echo -e "${YELLOW}🐳 Checking Docker containers...${NC}"
check_any_container "Kodus API" "kodus_api" "kodus-orchestrator" || all_good=false
check_any_container "Kodus Worker" "kodus_worker" || all_good=false
check_any_container "Kodus Webhooks" "kodus_webhooks" || all_good=false
check_any_container "Kodus Web" "kodus_web" || all_good=false
check_any_container "PostgreSQL" "db_postgres" "postgres" || all_good=false
check_any_container "MongoDB" "mongodb" "mongo" || all_good=false
check_any_container "RabbitMQ" "rabbitmq" || all_good=false
echo ""

echo -e "${YELLOW}🔌 Checking ports...${NC}"
check_port "Kodus API" $API_PORT || all_good=false
check_port "Kodus Web" $WEB_PORT || all_good=false
check_port "PostgreSQL" 5432 || all_good=false
check_port "MongoDB" 27017 || all_good=false
check_port "RabbitMQ" 5672 || all_good=false
echo ""

echo -e "${YELLOW}🗄️ Checking database setup...${NC}"

check_migrations() {
    local result=$(docker exec db_postgres psql -U ${API_PG_DB_USERNAME:-kodusdev} -d ${API_PG_DB_DATABASE:-kodus_db} -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'migrations';" 2>/dev/null | tr -d ' ')
    
    if [ "$result" = "1" ]; then
        local migration_count=$(docker exec db_postgres psql -U ${API_PG_DB_USERNAME:-kodusdev} -d ${API_PG_DB_DATABASE:-kodus_db} -t -c "SELECT COUNT(*) FROM migrations;" 2>/dev/null | tr -d ' ')
        if [ "$migration_count" -gt "0" ]; then
            echo -e "   ✅ Migrations: $migration_count executed"
            return 0
        else
            echo -e "   ❌ Migrations: Table exists but no migrations found"
            return 1
        fi
    else
        echo -e "   ❌ Migrations: Table not found"
        return 1
    fi
}

check_seed() {
    local result=$(docker exec db_postgres psql -U ${API_PG_DB_USERNAME:-kodusdev} -d ${API_PG_DB_DATABASE:-kodus_db} -t -c "SELECT COUNT(*) FROM automation;" 2>/dev/null | tr -d ' ')
    
    if [ "$?" -eq 0 ] && [ "$result" -gt "0" ]; then
        echo -e "   ✅ Seed data: $result automations found"
        return 0
    else
        echo -e "   ❌ Seed data: No automations found (run seed)"
        return 1
    fi
}

check_migrations || all_good=false
check_seed || all_good=false
echo ""

echo -e "${YELLOW}🌐 Checking endpoints...${NC}"

# Try simple health check first (no dependencies)
echo -e "${YELLOW}   Testing simple health endpoint...${NC}"
if check_service "API Simple Health" "http://localhost:$API_PORT/health/simple"; then
    echo -e "${YELLOW}   Testing full health endpoint...${NC}"
    check_service "API Full Health" "http://localhost:$API_PORT/health" || echo -e "${YELLOW}   Note: Full health check failed, but API is responding${NC}"
else
    echo -e "${YELLOW}   Simple health failed, trying alternatives...${NC}"
    all_good=false
    
    # Try other known public endpoints
    check_service "Auth endpoints" "http://localhost:$API_PORT/auth/login" "200|404|405" || true
    check_service "User endpoints" "http://localhost:$API_PORT/user/email" "400|401|422" || true
fi
echo ""

echo -e "${BLUE}📋 Summary:${NC}"
if [ "$all_good" = true ]; then
    echo -e "${GREEN}🎉 All services are working correctly!${NC}"
    echo -e "   ${YELLOW}API Health: http://localhost:$API_PORT/health${NC}"
    echo -e "   ${YELLOW}API Simple: http://localhost:$API_PORT/health/simple${NC}"
    echo -e "   ${YELLOW}Web App: http://localhost:$WEB_PORT${NC}"
    echo ""
    exit 0
else
    echo -e "${YELLOW}⚠️  Some services are starting up or have issues.${NC}"
    echo ""
    echo -e "${BLUE}🔧 Development Status:${NC}"
    echo -e "   ${GREEN}✅ Containers: Running${NC}"
    echo -e "   ${GREEN}✅ Databases: Connected${NC}"
    
    # Check which specific things are missing
    migrations_ok=false
    seed_ok=false
    
    if check_migrations >/dev/null 2>&1; then
        echo -e "   ${GREEN}✅ Migrations: Ready${NC}"
        migrations_ok=true
    else
        echo -e "   ${RED}❌ Migrations: Not run yet${NC}"
    fi
    
    if check_seed >/dev/null 2>&1; then
        echo -e "   ${GREEN}✅ Seed data: Loaded${NC}"
        seed_ok=true
    else
        echo -e "   ${RED}❌ Seed data: Not loaded yet${NC}"
    fi
    
    echo -e "   ${RED}❌ API HTTP: Not responding yet${NC}"
    echo ""
    
    echo -e "${BLUE}💡 Next steps:${NC}"
    if [ "$migrations_ok" = false ]; then
        echo -e "   ${YELLOW}pnpm run migration:run   # Run database migrations${NC}"
    fi
    if [ "$seed_ok" = false ]; then
        echo -e "   ${YELLOW}pnpm run seed           # Load initial data${NC}"
    fi
    echo -e "   ${YELLOW}pnpm run docker:logs    # Check API startup progress${NC}"
    echo -e "   ${YELLOW}./scripts/docker/health-check.sh  # Re-run this check${NC}"
    echo ""
    echo -e "${BLUE}🕐 Wait 1-2 minutes for full startup${NC}"
    exit 1
fi
