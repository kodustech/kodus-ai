# 🧪 End-to-End (E2E) Testing

![Tests](https://img.shields.io/badge/Tests-Passing-brightgreen)
![Coverage](https://img.shields.io/badge/Coverage-73%25-yellow)
![Node](https://img.shields.io/badge/Node.js-v18+-blue)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15-blue)

> Automated testing system for **Kodus MCP Manager** with PostgreSQL and smart mocks.

---

## 📁 Project Structure

```
test/
├── 📂 e2e/
│   └── mcp.e2e.spec.ts          # 🎯 MCP controller integration tests
├── 📂 __mocks__/
│   └── ...                     # 🎭 Test mocks
├── 🚀 run-e2e.sh               # 📜 Test execution script
└── 📚 README.md                # 📖 This documentation
```

---

## 🚀 Quick Start

```bash
# Run all tests
yarn test

# Run unit tests only
npx jest test/provider/

# Run E2E tests only
npx jest test/e2e/
```

---

## 🔄 Execution Flow

The `yarn test` command automatically executes:

| Step | Description | Status |
|------|-------------|--------|
| 🐳 | Check/start PostgreSQL container | ✅ |
| ⏳ | Wait for database to be ready | ✅ |
| 🗄️ | Create test database (`kodus_mcp_test`) | ✅ |
| 🔄 | Run migrations on test database | ✅ |
| 🧪 | Execute complete test suite | ✅ |
| 🧹 | Clean up test database | ✅ |

---

## ⚙️ Test Configuration

### 🎭 Mocks Used
- **ProviderFactory**: Mock for provider management
- **AuthMiddleware**: Mock for JWT authentication

### 🗃️ Database
- **Container**: Same PostgreSQL as development
- **Database**: `kodus_mcp_test` (isolated and temporary)
- **Migrations**: Executed automatically
- **Cleanup**: Database removed after tests

---

## 🌍 Environment Variables

| Variable | Value | Description |
|----------|-------|-------------|
| `NODE_ENV` | `test` | Execution environment |
| `JWT_SECRET` | `test-secret-key` | JWT key for tests |
| `MCP_PROVIDERS` | `kodusmcp,custom` | Enabled providers |
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_USERNAME` | `kodus` | Database username |
| `DB_PASSWORD` | `kodus123` | Database password |
| `DB_DATABASE` | `kodus_mcp_test` | Test database name |

---

## 📊 Test Coverage

### 🎯 E2E Tests (`mcp.e2e.spec.ts`)
- ✅ **11 tests** - MCP controller endpoints
- 🔗 Connections: listing, searching, updating
- 🔌 Integrations: listing, details, parameters, tools
- ⚠️ Error handling and validation

---

## 🛠️ Prerequisites

| Tool | Version | Status |
|------|---------|--------|
| 🐳 Docker | Latest | ✅ Required |
| 🐳 Docker Compose | Latest | ✅ Required |
| 📟 Node.js | v18+ | ✅ Required |
| 📦 Yarn | Latest | ✅ Required |

### 📥 Installation
```bash
# Install dependencies
yarn install

# Check if Docker is running
docker --version
docker-compose --version
```

---

## 🏆 Approach Benefits

| Benefit | Description |
|---------|-------------|
| 🎯 **Simplicity** | Uses the same PostgreSQL container as development |
| ⚡ **Efficiency** | No need to start additional containers |
| 🔒 **Isolation** | Separate test database (`kodus_mcp_test`) |
| 🧹 **Cleanup** | Database created and removed automatically |
| 🔄 **Flexibility** | Can run alongside development |
| 📊 **Coverage** | Unit + integration tests |

---

## 🐛 Troubleshooting

### ❌ Common Issues

**🔴 "Database not available"**
```bash
# Check if PostgreSQL is running
docker-compose ps

# Start database if needed
docker-compose up -d postgres
```

**🔴 "Port 5432 in use"**
```bash
# Check processes on port
lsof -i :5432

# Stop local PostgreSQL if needed
sudo systemctl stop postgresql
```

**🔴 "Migrations failed"**
```bash
# Clean test database manually
docker-compose exec postgres psql -U kodus -c "DROP DATABASE IF EXISTS kodus_mcp_test;"
```

---

## 📈 Statistics

```
📊 Test Summary
├── 🎯 Total Tests: 33
├── ✅ Passing: 33
├── ❌ Failing: 0
├── ⏱️ Average Time: ~9s
└── 📈 Coverage: 73.24%
```

---

## 🚀 Next Steps

- [ ] 📈 Increase coverage to 90%+
- [ ] 🧪 Add performance tests
- [ ] 🔄 Integration tests with external APIs
- [ ] 📱 API tests with different payloads
- [ ] 🛡️ Security and validation tests

---

<div align="center">

**🎉 Tests always up-to-date and working!**

[![Run Tests](https://img.shields.io/badge/▶️-Run%20Tests-success?style=for-the-badge)](yarn test)

</div>
