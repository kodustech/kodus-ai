<p align="center">
  <img alt="koduslogo" src="https://kodus.io/wp-content/uploads/2025/04/kodusweb.png">
</p>

<p align="center">
  <a href="https://kodus.io" target="_blank">Website</a>
  ·
  <a href="https://discord.gg/6WbWrRbsH7" target="_blank">Community</a>
  ·
  <a href="https://docs.kodus.io" target="_blank">Docs</a>
  ·
  <a href="https://app.kodus.io" target="_blank"><strong>Try Kodus Cloud »</strong></a>
</p>

<p align="center">
   <a href="https://github.com/kodustech/kodus-ai" target="_blank"><img src="https://img.shields.io/github/stars/kodustech/kodus-ai" alt="Github Stars"></a>
   <a href="../../license.md"><img src="https://img.shields.io/badge/license-AGPLv3-red" alt="License"></a>
</p>

<h3 align="center">A modern, intuitive interface for managing your code reviews.</h3>

<br/>

## About Kodus Web

Kodus Web is the official web interface for Kodus, delivering a modern and intuitive experience for managing your code reviews.

This app is part of the Kodus monorepo at `apps/web`.

### Key Features

- **Modern Interface** — Clean and intuitive design that makes navigation and review management a breeze
- **Responsive Design** — Perfectly crafted for both desktop and mobile devices
- **Dark Mode** — Eye-friendly dark theme for comfortable viewing
- **API Integration** — Efficient communication with the Kodus backend

## Getting Started

### Prerequisites

- Node.js 22.x
- pnpm
- Docker

### Installation

1. Clone the monorepo:

```bash
git clone https://github.com/kodustech/kodus-ai.git
cd kodus-ai
```

2. Install dependencies:

```bash
pnpm install
```

3. Configure environment and generated secrets:

```bash
pnpm setup
```

4. Run web in development mode:

```bash
pnpm web:dev
```

Optional: run full stack (backend + web + infra):

```bash
pnpm docker:start
```

## Tech Stack

- **Framework**: Next.js 15
- **Language**: TypeScript
- **Styling**:
    - Tailwind CSS
    - Radix UI
    - Lucide React
- **State Management**:
    - React Query (TanStack Query)
    - React Hook Form
- **Authentication**: NextAuth.js
- **Data Visualization**: Victory
- **Development Tools**:
    - ESLint
    - Prettier
    - TypeScript
    - Docker

## Contributing

We welcome contributions!
