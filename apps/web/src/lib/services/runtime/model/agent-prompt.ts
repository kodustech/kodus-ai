/** The prompt for the developer's own coding agent: it already knows how to run the project. */
export const agentPrompt = (repositoryName: string) =>
    [
        `Write .kodus/workspace.yaml for ${repositoryName}, so Kody Runtime can boot this app on a clean machine.`,
        "If .kodus/workspace.yaml already exists for another tool, write .kodus/workspace.runtime.yaml instead: Kody Runtime reads it first and leaves the other file alone.",
        "",
        "Use what already runs it here (CI workflow, docker-compose, README, .nvmrc / .tool-versions). Format, version 1:",
        "version: 1",
        "setup: [commands that install the toolchain and dependencies]",
        "services:",
        "  compose: { files: [docker-compose.yml], public: <service the app answers on>, health: /health, health_timeout: 120s }",
        "  expose: [{ service: <name>, port: <port>, kind: http | postgres }]",
        "data:",
        "  migrate: <command that runs the migrations>",
        "  seed: <command or { service, sql, user, database } that loads test data>",
        "",
        "Never copy .env or any secret into the recipe: name the variables the app needs and use test values or fakes.",
        "Then boot it locally with the recipe, check the health URL answers, and open a pull request with the file.",
    ].join("\n");
