# Contributing to Kodus

Thank you for your interest in contributing to Kodus! This document provides guidelines and instructions for contributing to our project.

## Table of Contents
- [Prerequisites](#prerequisites)
- [Setting Up Development Environment](#setting-up-development-environment)
- [Project Structure](#project-structure)
- [Code Conventions](#code-conventions)
- [Contribution Process](#contribution-process)
- [Testing](#testing)
- [Documentation](#documentation)
- [Commit Guidelines](#commit-guidelines)
- [Code of Conduct](#code-of-conduct)

## Prerequisites

Before you begin, ensure you have the following installed:
- Node.js 22.x
- Docker
- Yarn or NPM
- Git

## Setting Up Development Environment

### 1. Clone the Repository
```bash
git clone https://github.com/kodustech/kodus-ai.git
cd kodus-ai
```

### 2. Install Dependencies
```bash
pnpm install
```

### 3. Configure Environment Variables

**Kodus engineers (1Password):**

```bash
pnpm run env:pull
```

Pulls secrets from the `Kodus Dev` 1Password vault into a fresh `.env`.
First-time setup (install `op` CLI, get vault access) is in
[`scripts/env/README.md`](./scripts/env/README.md#pulling-values-from-1password).

**External contributors:**

```bash
cp .env.example .env
```

Then fill in required values by hand — comments in `.env.example` say which are required. Refer to the [Orchestrator documentation](https://docs.kodus.io/how_to_deploy/en/local_quickstart/orchestrator) for detailed configuration instructions.

### 4. Set Up Docker Networks
```bash
docker network create kodus-backend-services
docker network create shared-network
```

### 5. Start Development Environment
```bash
pnpm run docker:start
```

### 6. First-time Setup
No additional command is needed for migrations/seed in the default Docker flow.
`pnpm run docker:start` already runs backend migrations + seed automatically.

### Frontend in Monorepo
The web frontend is now in this same repository under `apps/web`.

- Run full stack (backend + web): `pnpm run docker:start`
- Run only web locally: `pnpm run web:install && pnpm run web:dev`

Default local endpoints:

- Web: `http://localhost:3000`
- API: `http://localhost:3001`

## Project Structure

The repository is organized as a monorepo:

```
├── apps/
│   ├── api/
│   ├── webhooks/
│   ├── worker/
│   └── web/
├── libs/
├── packages/
├── test/
├── scripts/
│   ├── dev/
│   ├── docker/
│   ├── gitops/
│   └── ...
├── docker/
└── docs/
```

## Code Conventions

- Follow TypeScript best practices
- Use ESLint and Prettier for code formatting
- Write meaningful comments and documentation
- Follow SOLID principles
- Use dependency injection where appropriate
- Write unit tests for new features

## Contribution Process

1. Fork the repository
2. Create a new branch for your feature/fix
3. Make your changes
4. Write/update tests
5. Update documentation
6. Submit a pull request

### Pull Request Guidelines
- Provide a clear description of changes
- Reference related issues
- Ensure all tests pass
- Update documentation as needed
- Follow the commit message convention

## Testing

We use Jest for testing. Run tests with:
```bash
pnpm run test
```

For specific test types:
```bash
pnpm run test:e2e     # End-to-end tests
pnpm run test:cov     # Test coverage
pnpm run test:watch   # Watch mode
```

## Documentation

- Keep documentation up-to-date
- Use clear and concise language
- Include examples where appropriate
- Document API changes
- Update README when necessary

## Commit Guidelines

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

Types:
- feat: New feature
- fix: Bug fix
- docs: Documentation changes
- style: Code style changes
- refactor: Code refactoring
- test: Test changes
- chore: Maintenance tasks

## Getting Help

If you need help or have questions:
- Check our [documentation](https://docs.kodus.io)
- Open an issue
- Join our community chat

Thank you for contributing to Kodus! 
