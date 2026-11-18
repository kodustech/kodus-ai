/**
 * Options for every yaml.load of text a repository or a model wrote (recipes,
 * compose files, workspace files). An anchor that is referenced many times,
 * nested a few levels, expands exponentially when the document is walked or
 * dumped: a compose file of under 1 KB can hang the process that checks it.
 * Twenty aliases keep the anchors real compose files use and refuse that.
 */
export const UNTRUSTED_YAML = { maxAliases: 20 } as const;
