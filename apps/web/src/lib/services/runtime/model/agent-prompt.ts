/**
 * The prompt for the developer's own coding agent: it already knows how to run the project, and with the Kodus CLI it
 * checks the recipe, sends it to Kodus to boot on a clean machine, and reads why it failed, with the developer's own model.
 */
export const agentPrompt = (repositoryName: string) =>
    [
        `Write .kodus/workspace.yaml for ${repositoryName}, so Kody Runtime can boot this app on a clean machine.`,
        "First run `kodus env recipe guide` and follow it: it has the recipe format and the rules the sandbox applies, which win over the summary below.",
        "If .kodus/workspace.yaml already exists for another tool, write .kodus/workspace.runtime.yaml instead: Kody Runtime reads it first and leaves the other file alone.",
        "",
        "Use what already runs it here (the CI job that boots it for e2e or integration tests, docker-compose, Dockerfile, README, .nvmrc / .tool-versions). Format, version 1:",
        "version: 1",
        "setup: [commands that install the toolchain and dependencies]",
        "services:",
        "  compose: { files: [docker-compose.yml], public: <service the app answers on>, health: /health, health_timeout: 120s }",
        "  expose: [{ service: <name>, port: <port>, kind: http | postgres }]",
        "data:",
        "  migrate: <command that runs the migrations>",
        "  seed: <command or { service, sql, user, database } that loads test data>",
        "",
        "A Dockerfile or compose file the repository lacks, or that is broken, goes directly under .kodus/ (at most 4 files, 16 KiB each) and the recipe names it there.",
        "Paths in a compose file under .kodus/ are relative to the repository root, not to .kodus/ (build: { context: ., dockerfile: .kodus/Dockerfile }); .. is refused.",
        "Never copy .env or any secret into the recipe: name the variables the app needs and use test values or fakes; external services get emulators or fakes.",
        "",
        "Then, with the Kodus CLI (a team key with env:fix, this repository added to it):",
        "1. kodus env recipe check, until it answers ok.",
        "2. kodus env recipe submit --wait: Kodus boots it from zero on a clean machine.",
        "3. Blocked: read the blockers it prints, fix the recipe or the .kodus/ files, and submit again.",
        "4. Active: open a pull request with .kodus/; a committed recipe always wins over a submitted one.",
    ].join("\n");
