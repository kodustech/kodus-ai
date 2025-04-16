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
- Node.js (LTS version)
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
yarn install
```

### 3. Configure Environment Variables
```bash
cp .env.example .env
```

Configure your `.env` file with the required variables. Refer to the [Orchestrator documentation](https://docs.kodus.io/how_to_deploy/en/local_quickstart/orchestrator) for detailed configuration instructions.

### 4. Set Up Docker Networks
```bash
docker network create kodus-backend-services
docker network create shared-network
```

### 5. Start Development Environment
```bash
yarn docker:start
```

### 6. First-time Setup
```bash
yarn migrate:dev
yarn seed
```

### Important Note About Frontend
For a complete development environment, you'll also need to set up the [frontend](https://github.com/kodustech/web). Please follow the frontend setup guide in our [web documentation](https://docs.kodus.io/how_to_deploy/en/local_quickstart/web) after setting up this repository.

The frontend will be available at `http://localhost:3000` and will communicate with this API at `http://localhost:3331`.

## Project Structure

The project follows a clean, modular architecture:

```
├── src/
│   ├── config/
│   ├── core/
│   ├── shared/
│   └── modules/
├── test/
├── scripts/
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
yarn test
```

For specific test types:
```bash
yarn test:unit    # Unit tests
yarn test:e2e     # End-to-end tests
yarn test:cov     # Test coverage
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