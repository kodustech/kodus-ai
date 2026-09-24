# Web - Next.js Dashboard

Frontend for the Kodus platform.

## What Agents Get Wrong

- UI components use **Radix UI** (themes + primitives) with **CVA** for variants — not shadcn, not Material UI
- Styling is **TailwindCSS 4** (not v3) — uses CSS variables for theming, dark theme by default
- State management: **no store library** (no Redux, no Zustand). Uses React Query for server state, React Context for app state (SelectedTeam, Permissions, Byok), nuqs for URL params
- Auth is **NextAuth v5 beta** with JWT sessions — not cookie sessions, not custom auth
- Route structure uses App Router **grouped routes**: `(app)` for authenticated, `(auth)` for public, `(setup)` for onboarding
- Cockpit dashboard uses **parallel routes** (`@bugRatioAnalytics`, `@prCycleTimeAnalytics`, etc.) — not regular nested routes
- Forms use **react-hook-form + Zod** — not Formik, not uncontrolled forms
- Rich text editor is **TipTap** — not Slate, not Draft.js
- Charts use **Victory** and **react-google-charts**
- No i18n. English only

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
