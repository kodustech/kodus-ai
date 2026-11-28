/**
 * Version of the detector compiler: `COMPILER_SYSTEM_PROMPT` and the output
 * contract in `kody-rules-detector.compiler.ts`. It is part of
 * `ruleCompileHash`, so a rule the compiler already attempted is compiled
 * again only when its text, its examples or this number changes.
 *
 * BUMP THIS when a compiler change should reach rules nobody edits: a prompt
 * change that alters which rules compile or what detector they get, or a
 * change to the output schema or the gate. Each bump recompiles every active
 * rule once, on the next nightly sweep or save, on the customer's BYOK key.
 * Leave it alone for wording edits that should not cost that.
 *
 * A bump refreshes only the detector and its compile attempt. The same call
 * also infers `fileScope` and `contextNeed`, but those are keyed separately
 * (`saveFileScope` on the rule text, `CONTEXT_NEED_PROMPT_VERSION`), so a rule
 * that already has them keeps them.
 *
 * Kept in its own file so `compile-hash` can read it without loading the
 * compiler. Version 1 adds nothing to the hash, so hashes stored before the
 * version existed stay current.
 *
 *   1 — the compiler as of PR #2754 (no salt).
 */
export const DETECTOR_COMPILER_VERSION = 1;
