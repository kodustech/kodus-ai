# Kody Runtime module docs

Every module of the Runtime has an `AGENTS.md` next to its code. It is written for whoever changes that module next, a person or a coding agent, and answers six questions before they read the code: what the module is for, what it owns, what it must not do, what calls it and what it calls, where new code goes, and how it is tested.

A module is a directory with at least one source file that is not a test, under `apps/runtime/src`, `libs/runtime`, `libs/runtime-publish`, `apps/runtime-cell/internal` or `apps/runtime-cell/cmd`. `node scripts/runtime/module-docs.mjs --list` prints them.

## Why this shape

- **Nested `AGENTS.md`, nearest file wins** ([agents.md](https://agents.md)). Coding agents load the file of the directory they work in, so a module's rules arrive with the code they govern. The package's `AGENTS.md` (`apps/runtime-cell/AGENTS.md`, `apps/runtime/AGENTS.md`, `libs/runtime/AGENTS.md`) keeps the rules every module of the package shares; a module's file never repeats them, it links them.
- **What the code can say is generated.** The module map at the end of each file (its files, the Runtime modules it imports and the ones that import it) comes from the import statements, so it cannot drift: `--check` fails when it is stale. What only a person can say is written once, briefly, and points at `file:symbol` instead of copying code.
- **The system map is one page.** [architecture.md](architecture.md) has the processes, the flows across them and the table of where new code goes. A module's file says where it sits in that map.

## The template

Keep it under about 60 lines above the module map. Delete a section that would be empty rather than writing "none".

```markdown
# <path from the repo root>

<Two or three sentences: what this module is for, in the terms of architecture.md. Which process it runs in
(API, product worker, runtime-hub, runtime-worker, cell, inside a machine) and which role it plays there
(domain rule, port, adapter, use case, composition root, test double).>

## Owns
- <the decisions and the state that live here, each with its entry point: `file.ts` `Symbol`>

## Does not own
- <what a reader might expect here and where it lives instead: "the claim's state transitions: `apps/runtime/src/hub/hub-store.ts`">

## Rules and limits
- <invariants, bounds, security rules this module enforces or depends on; a rule of the package's AGENTS.md is linked, not restated>

## Where new code goes
- <a new X → this file or that module; the change that must come with it (a migration, a fixture, the README table)>

## Tests
- <where the tests are, what they need (Postgres, KVM, root), the command>

<!-- module-map:start ... -->  (generated, never edited by hand)
```

## Writing rules

- State what the code does today, read in the code, not what a plan says it will do. A gap is a line under **Rules and limits** naming the missing piece.
- Name things by their path and symbol (`internal/drivers/microvm/build.go` `vmBuilder.script`), never by line number: lines move.
- A rule belongs to the module that enforces it. Write it there; elsewhere, link.
- No secrets, hostnames of real infrastructure, instance ids, customer names or log excerpts. These files are in a public repository.
- English, short sentences, the root `AGENTS.md` writing rules.

## Keeping them true

```sh
node scripts/runtime/module-docs.mjs --check   # a module without AGENTS.md, or a stale module map
node scripts/runtime/module-docs.mjs --write   # rewrite every module map after moving or adding imports
```

A change that adds, moves or deletes a module, or changes what it imports, runs `--write` and commits the result with the change. A new module ships with its `AGENTS.md`.
