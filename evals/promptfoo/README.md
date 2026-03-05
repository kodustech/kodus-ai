# Code Review Evaluation

Benchmark suite for evaluating LLM performance on code review tasks. Uses [promptfoo](https://promptfoo.dev) to run the production prompt across multiple models and score results with a dual-judge system.

## Table of Contents

- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [How the Pipeline Works](#how-the-pipeline-works)
- [Dataset Format](#dataset-format)
    - [Top-Level Structure](#top-level-structure)
    - [Which Fields Actually Matter](#which-fields-actually-matter)
- [Single-File Dataset (Normal)](#single-file-dataset-normal)
    - [Minimal Template](#minimal-template-normal)
    - [Full Example](#full-example-normal)
- [Cross-File Dataset](#cross-file-dataset)
    - [What Changes](#what-changes-vs-normal)
    - [crossFileSnippets Format](#crossfilesnippets-format)
    - [Minimal Template](#minimal-template-cross-file)
    - [Full Example](#full-example-cross-file)
- [Shared: codeSuggestions Format](#shared-codesuggestions-format)
- [Shared: patchWithLinesStr Format](#shared-patchwithlinesstr-format)
- [Adding Examples to an Existing Dataset](#adding-examples-to-an-existing-dataset)
- [Adding a New Language](#adding-a-new-language)
- [Bug Examples by Complexity](#bug-examples-by-complexity)
    - [Simple: Single Bug (TypeScript)](#simple-single-bug-typescript)
    - [Medium: Multi-Bug with Security + Logic (Python)](#medium-multi-bug-with-security--logic-python)
    - [Hard: Race Condition + Resource Leak + SSRF (Java)](#hard-race-condition--resource-leak--ssrf-java)
    - [Cross-File: Renamed Enum Breaks 3 Consumers (TypeScript)](#cross-file-renamed-enum-breaks-3-consumers-typescript)
    - [Cross-File: Changed Return Type (Python)](#cross-file-changed-return-type-python)
- [Good Bug Patterns Reference](#good-bug-patterns-reference)
- [Running the Eval](#running-the-eval)
- [Analyzing Results](#analyzing-results)
- [Scoring and Metrics](#scoring-and-metrics)
- [Models and Providers](#models-and-providers)
- [Regenerating the Prompt](#regenerating-the-prompt)
- [Troubleshooting](#troubleshooting)

---

## Quick Start

```bash
# 1. Install promptfoo
npm install -g promptfoo

# 2. Set API keys in the root .env
#    API_OPEN_AI_API_KEY=sk-...
#    API_ANTHROPIC_API_KEY=sk-ant-...
#    API_GOOGLE_AI_API_KEY=AI...
#    API_OPENROUTER_KEY=sk-or-...

# 3. Run
yarn eval:codereview

# 4. Analyze
yarn eval:codereview:analyze
```

---

## Project Structure

```
evals/promptfoo/
├── datasets_ast/                  # SOURCE OF TRUTH — you edit these
│   ├── tsjs.jsonl                 # TS/JS normal (10 examples)
│   ├── tsjs_crossfile.jsonl       # TS/JS cross-file (5 examples)
│   ├── react.jsonl                # React normal (10 examples)
│   ├── react_crossfile.jsonl      # React cross-file (5 examples)
│   ├── python.jsonl               # Python normal (10 examples)
│   ├── python_crossfile.jsonl     # Python cross-file (5 examples)
│   ├── java.jsonl                 # Java normal (10 examples)
│   ├── java_crossfile.jsonl       # Java cross-file (5 examples)
│   ├── ruby.jsonl                 # Ruby normal (10 examples)
│   └── ruby_crossfile.jsonl       # Ruby cross-file (5 examples)
├── datasets/
│   └── codereview-tests.json      # AUTO-GENERATED — never edit this
├── convert-dataset.js             # Converts .jsonl → codereview-tests.json
├── promptfoo.yaml                 # Provider config
├── generated-prompt.json          # Production prompt (pre-built)
├── generate-prompt.ts             # Rebuilds prompt from codebase
├── prompt-loader.js               # Loads prompt for promptfoo
├── parse-output.js                # Production parser replica
├── parse-assertion.js             # Assert: output is parseable
├── judge-assertion.js             # Assert: dual LLM judge (Sonnet + GPT)
├── line-accuracy-assertion.js     # Assert: IoU line range comparison
├── analyze-results.js             # Leaderboard generator
├── run-eval.sh                    # Entry point
└── results/
    ├── output-normal.json         # Results from normal run
    └── output-crossfile.json      # Results from cross-file run
```

**Important**: You add data to `datasets_ast/*.jsonl`. The pipeline auto-generates everything else.

---

## How the Pipeline Works

```
datasets_ast/*.jsonl          ← YOU WRITE THIS
    ↓
convert-dataset.js            reads .jsonl, builds promptfoo test cases
    ↓
datasets/codereview-tests.json
    ↓
promptfoo eval                sends to each provider
    ↓
3 assertions per response:
  1. parse-assertion.js       can production parser handle it?
  2. judge-assertion.js       Sonnet + GPT judge coverage & validity
  3. line-accuracy-assertion.js   IoU of predicted vs reference lines
    ↓
results/output-*.json
    ↓
analyze-results.js            ranked leaderboard
```

---

## Dataset Format

### Top-Level Structure

Every line in a `.jsonl` file is a JSON object with this shape:

```json
{
  "inputs": {
    "inputs": {
      ...
    }
  },
  "outputs": {
    "reference_outputs": {
      "codeSuggestions": [...]
    }
  }
}
```

Yes, `inputs.inputs` is nested twice — that's the LangSmith export format the pipeline expects.

### Which Fields Actually Matter

`convert-dataset.js` reads **only these fields**. Everything else is ignored:

#### From inputs

| Field                             | Required            | Goes where                                      |
| --------------------------------- | ------------------- | ----------------------------------------------- |
| `inputs.inputs.fileContent`       | yes                 | Prompt: full source code of the file            |
| `inputs.inputs.patchWithLinesStr` | yes                 | Prompt: the diff being reviewed                 |
| `inputs.inputs.pullRequest.body`  | yes                 | Prompt: PR description (used as `prSummary`)    |
| `inputs.inputs.filePath`          | yes                 | Test case description label                     |
| `inputs.inputs.crossFileSnippets` | **cross-file only** | Prompt: formatted as "External Context" section |

#### From outputs

| Field                                  | Required | Used by                                  |
| -------------------------------------- | -------- | ---------------------------------------- |
| `codeSuggestions[].relevantFile`       | yes      | Line accuracy assertion                  |
| `codeSuggestions[].relevantLinesStart` | yes      | Line accuracy assertion                  |
| `codeSuggestions[].relevantLinesEnd`   | yes      | Line accuracy assertion                  |
| `codeSuggestions[]` (full object)      | yes      | Serialized as JSON and sent to the judge |

#### Ignored fields (can be omitted)

`metadata`, `language`, `groupingMode`, `reviewOptions`, `limitationType`, `severityLevelFilter`, `languageResultPrompt`, `maxSuggestionsParams`, `organizationAndTeamData`, `overallSummary` — none of these are read by the pipeline. Include them if you want, but they don't affect anything.

---

## Single-File Dataset (Normal)

### Minimal Template (Normal)

```json
{
    "inputs": {
        "inputs": {
            "filePath": "src/utils/retry.ts",
            "fileContent": "export async function retry<T>(...) {\n  for (let i = 0; i <= max; i++) {\n    ...\n  }\n}\n",
            "patchWithLinesStr": "## file: 'src/utils/retry.ts'\n\n@@ -0,0 +1,12 @@\n__new hunk__\n1 +export async function retry<T>(...) {\n2 +  for (let i = 0; i <= max; i++) {\n...\n__old hunk__\n",
            "pullRequest": {
                "body": "Add retry utility with exponential backoff"
            }
        }
    },
    "outputs": {
        "reference_outputs": {
            "codeSuggestions": [
                {
                    "label": "bug",
                    "relevantFile": "src/utils/retry.ts",
                    "relevantLinesStart": 2,
                    "relevantLinesEnd": 2,
                    "existingCode": "for (let i = 0; i <= max; i++) {",
                    "improvedCode": "for (let i = 0; i < max; i++) {",
                    "suggestionContent": "Off-by-one: i <= max runs max+1 times instead of max.",
                    "oneSentenceSummary": "Off-by-one in retry loop"
                }
            ]
        }
    }
}
```

That's it. No extra fields needed.

### Full Example (Normal)

A complete, realistic single-line entry (minified for `.jsonl`):

```json
{
    "inputs": {
        "inputs": {
            "filePath": "src/auth/password.ts",
            "fileContent": "import * as bcrypt from 'bcrypt';\n\nexport async function hashPassword(password: string): Promise<string> {\n  return bcrypt.hash(password, 1);\n}\n\nexport async function verifyPassword(password: string, hash: string): Promise<boolean> {\n  return password === hash;\n}\n",
            "patchWithLinesStr": "## file: 'src/auth/password.ts'\n\n@@ -0,0 +1,9 @@\n__new hunk__\n1 +import * as bcrypt from 'bcrypt';\n2 +\n3 +export async function hashPassword(password: string): Promise<string> {\n4 +  return bcrypt.hash(password, 1);\n5 +}\n6 +\n7 +export async function verifyPassword(password: string, hash: string): Promise<boolean> {\n8 +  return password === hash;\n9 +}\n__old hunk__\n",
            "pullRequest": { "body": "Add password hashing utilities" }
        }
    },
    "outputs": {
        "reference_outputs": {
            "codeSuggestions": [
                {
                    "label": "bug",
                    "relevantFile": "src/auth/password.ts",
                    "relevantLinesStart": 4,
                    "relevantLinesEnd": 4,
                    "existingCode": "return bcrypt.hash(password, 1);",
                    "improvedCode": "return bcrypt.hash(password, 12);",
                    "suggestionContent": "Salt rounds of 1 makes bcrypt trivially brute-forceable. Use at least 10-12 rounds.",
                    "oneSentenceSummary": "bcrypt salt rounds too low (1)"
                },
                {
                    "label": "bug",
                    "relevantFile": "src/auth/password.ts",
                    "relevantLinesStart": 8,
                    "relevantLinesEnd": 8,
                    "existingCode": "return password === hash;",
                    "improvedCode": "return bcrypt.compare(password, hash);",
                    "suggestionContent": "verifyPassword compares plaintext password directly with hash using ===. This will always return false for valid hashes and completely bypasses bcrypt verification.",
                    "oneSentenceSummary": "Password verification does string comparison instead of bcrypt.compare"
                }
            ]
        }
    }
}
```

---

## Cross-File Dataset

### What Changes vs Normal

**One field added**: `crossFileSnippets` inside `inputs.inputs`. That's the only difference.

The cross-file snippets are code from **other files in the repo** that depend on the file being changed. The model needs to see these to detect that the diff broke a contract.

### crossFileSnippets Format

```json
"crossFileSnippets": [
  {
    "filePath": "src/services/checkout.service.ts",
    "relatedSymbol": "CheckoutService.completeOrder",
    "rationale": "Emits 'orderCompleted' event that was renamed in the diff",
    "content": "import { EventRegistry } from '../events/registry';\n\nexport class CheckoutService {\n  async completeOrder(id: string) {\n    await this.registry.emit('orderCompleted', { id });\n  }\n}"
  }
]
```

| Field           | Required             | Description                                                                         |
| --------------- | -------------------- | ----------------------------------------------------------------------------------- |
| `filePath`      | yes                  | Path of the dependent/consumer file                                                 |
| `content`       | yes                  | The relevant code snippet (not the whole file — just enough to show the dependency) |
| `rationale`     | yes                  | Why this snippet is relevant to the diff                                            |
| `relatedSymbol` | no (but recommended) | The specific class/method that depends on the changed code                          |

### Minimal Template (Cross-File)

```json
{
    "inputs": {
        "inputs": {
            "filePath": "src/events/registry.ts",
            "fileContent": "export class EventRegistry {\n  private registerDefaults() {\n    this.register('order.finalized', this.handleOrder.bind(this));\n  }\n}\n",
            "patchWithLinesStr": "## file: 'src/events/registry.ts'\n@@ -3,3 +3,3 @@\n__new hunk__\n3 +    this.register('order.finalized', this.handleOrder.bind(this));\n__old hunk__\n3 -    this.register('orderCompleted', this.handleOrder.bind(this));",
            "pullRequest": {
                "body": "Rename events to domain-driven format"
            },
            "crossFileSnippets": [
                {
                    "filePath": "src/services/checkout.service.ts",
                    "relatedSymbol": "CheckoutService.completeOrder",
                    "rationale": "Emits 'orderCompleted' which was renamed",
                    "content": "import { EventRegistry } from '../events/registry';\n\nexport class CheckoutService {\n  async completeOrder(id: string) {\n    await this.registry.emit('orderCompleted', { id });\n  }\n}"
                }
            ]
        }
    },
    "outputs": {
        "reference_outputs": {
            "codeSuggestions": [
                {
                    "label": "bug",
                    "relevantFile": "src/events/registry.ts",
                    "relevantLinesStart": 3,
                    "relevantLinesEnd": 3,
                    "existingCode": "this.register('order.finalized', this.handleOrder.bind(this));",
                    "improvedCode": "// WARNING: CheckoutService still emits 'orderCompleted'\nthis.register('order.finalized', this.handleOrder.bind(this));",
                    "suggestionContent": "Event renamed from 'orderCompleted' to 'order.finalized' but CheckoutService.completeOrder() still emits 'orderCompleted'. The handler will never fire.",
                    "oneSentenceSummary": "Renamed event breaks CheckoutService caller"
                }
            ]
        }
    }
}
```

### Full Example (Cross-File)

```json
{
    "inputs": {
        "inputs": {
            "filePath": "src/config/permissions.ts",
            "fileContent": "export const PERMISSIONS = {\n  READ: 'read',\n  WRITE: 'write',\n  ADMIN: 'admin',\n  SUPER_ADMIN: 'superadmin',\n} as const;\n\nexport type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS];\n\nexport function hasAccess(userPerms: Permission[], required: Permission): boolean {\n  return userPerms.includes(required);\n}\n",
            "patchWithLinesStr": "## file: 'src/config/permissions.ts'\n@@ -1,6 +1,6 @@\n__new hunk__\n1  export const PERMISSIONS = {\n2    READ: 'read',\n3    WRITE: 'write',\n4 +  ADMIN: 'admin',\n5 +  SUPER_ADMIN: 'superadmin',\n6  } as const;\n__old hunk__\n1  export const PERMISSIONS = {\n2    READ: 'read',\n3    WRITE: 'write',\n4 -  ADMIN: 'administrator',\n5 -  SUPER_ADMIN: 'super_administrator',\n6  } as const;",
            "pullRequest": { "body": "Simplify permission string values" },
            "crossFileSnippets": [
                {
                    "filePath": "src/middleware/auth.middleware.ts",
                    "relatedSymbol": "requireAdmin",
                    "rationale": "Uses PERMISSIONS.ADMIN string value for role check",
                    "content": "import { PERMISSIONS } from '../config/permissions';\n\nexport function requireAdmin(req, res, next) {\n  const role = req.user?.role;\n  if (role !== 'administrator') {\n    return res.status(403).json({ error: 'Forbidden' });\n  }\n  next();\n}"
                },
                {
                    "filePath": "src/services/audit.service.ts",
                    "relatedSymbol": "AuditService.isPrivileged",
                    "rationale": "Checks for 'super_administrator' string literal",
                    "content": "export class AuditService {\n  isPrivileged(userRole: string): boolean {\n    return userRole === 'super_administrator';\n  }\n\n  async logAction(userId: string, action: string) {\n    if (this.isPrivileged(await this.getRole(userId))) {\n      return; // skip audit for super admins\n    }\n    await this.store.append({ userId, action, timestamp: Date.now() });\n  }\n}"
                }
            ]
        }
    },
    "outputs": {
        "reference_outputs": {
            "codeSuggestions": [
                {
                    "label": "bug",
                    "relevantFile": "src/config/permissions.ts",
                    "relevantLinesStart": 4,
                    "relevantLinesEnd": 4,
                    "existingCode": "ADMIN: 'admin',",
                    "improvedCode": "// WARNING: auth.middleware.ts hardcodes 'administrator'\nADMIN: 'admin',",
                    "suggestionContent": "ADMIN value changed from 'administrator' to 'admin' but auth.middleware.ts still compares against the hardcoded string 'administrator'. Admin users will be denied access on all protected routes.",
                    "oneSentenceSummary": "Renamed ADMIN value breaks auth middleware hardcoded check"
                },
                {
                    "label": "bug",
                    "relevantFile": "src/config/permissions.ts",
                    "relevantLinesStart": 5,
                    "relevantLinesEnd": 5,
                    "existingCode": "SUPER_ADMIN: 'superadmin',",
                    "improvedCode": "// WARNING: audit.service.ts hardcodes 'super_administrator'\nSUPER_ADMIN: 'superadmin',",
                    "suggestionContent": "SUPER_ADMIN value changed from 'super_administrator' to 'superadmin' but AuditService.isPrivileged() still checks for 'super_administrator'. Super admins will no longer be recognized as privileged, so all their actions will be audit-logged (and the skip logic breaks).",
                    "oneSentenceSummary": "Renamed SUPER_ADMIN value breaks AuditService privilege check"
                }
            ]
        }
    }
}
```

---

## Shared: codeSuggestions Format

Each bug in `outputs.reference_outputs.codeSuggestions[]`:

```json
{
    "label": "bug",
    "relevantFile": "src/path/to/file.ts",
    "relevantLinesStart": 80,
    "relevantLinesEnd": 85,
    "existingCode": "the buggy code",
    "improvedCode": "the fixed code",
    "suggestionContent": "Detailed explanation of the bug and why it breaks.",
    "oneSentenceSummary": "One-line summary"
}
```

| Field                | Used by       | Notes                                                           |
| -------------------- | ------------- | --------------------------------------------------------------- |
| `relevantFile`       | Line accuracy | Must match `filePath` from inputs (the diff file)               |
| `relevantLinesStart` | Line accuracy | Line number in the diff where the bug starts                    |
| `relevantLinesEnd`   | Line accuracy | Line number in the diff where the bug ends                      |
| `existingCode`       | Judge         | The buggy snippet for the judge to compare                      |
| `improvedCode`       | Judge         | The fix for reference                                           |
| `suggestionContent`  | Judge         | Detailed explanation — this is what the judge evaluates against |
| `oneSentenceSummary` | Judge         | Short description                                               |
| `label`              | Judge         | Always `"bug"`                                                  |

For **cross-file bugs**: `relevantFile` and line numbers point to the **diff file** (where the breaking change was introduced), not the consumer file. Mention the consumer file in `suggestionContent`.

---

## Shared: patchWithLinesStr Format

The diff must follow the Kodus production format:

### New file (no old code)

```
## file: 'src/path/to/file.ts'

@@ -0,0 +1,20 @@
__new hunk__
1 +import { something } from './dep';
2 +
3 +export function myFunction() {
4 +  return doStuff();
5 +}
__old hunk__
```

### Modified file

```
## file: 'src/path/to/file.ts'
@@ -27,7 +27,7 @@
__new hunk__
27   private registerDefaults(): void {
28 +    this.register('order.finalized', this.handle.bind(this));
32   }
__old hunk__
27   private registerDefaults(): void {
28 -    this.register('orderCompleted', this.handle.bind(this));
32   }
```

- `+` prefix = added lines (in new hunk)
- `-` prefix = removed lines (in old hunk)
- No prefix = context lines (unchanged)
- Line numbers at the start of each line

---

## Adding Examples to an Existing Dataset

To add more test cases to an existing language dataset (e.g., more TypeScript bugs):

### 1. Open the target file

```
evals/promptfoo/datasets_ast/tsjs.jsonl          # normal TS/JS
evals/promptfoo/datasets_ast/tsjs_crossfile.jsonl # cross-file TS/JS
evals/promptfoo/datasets_ast/python.jsonl         # normal Python
# ... etc
```

### 2. Write your example as a JSON object

Use the templates from the sections above. Make sure it's a **single line** — no line breaks inside the JSON.

**Tip**: write the JSON pretty-printed first, then minify it:

```bash
# Minify a pretty-printed JSON file into one line
node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('my-example.json','utf8'))))"
```

### 3. Append the line to the file

```bash
# Append (don't overwrite!) to the existing dataset
cat my-example-minified.json >> evals/promptfoo/datasets_ast/tsjs.jsonl
```

Or just paste the line at the end of the file in your editor.

### 4. Validate

```bash
node -e "
  const f = 'evals/promptfoo/datasets_ast/tsjs.jsonl';
  const lines = require('fs').readFileSync(f,'utf8').split('\n').filter(Boolean);
  lines.forEach((l,i) => {
    try { JSON.parse(l); }
    catch(e) { console.error('Line '+(i+1)+': '+e.message); process.exit(1); }
  });
  console.log(lines.length + ' valid examples');
"
```

### 5. Run only your new example

```bash
# Run just the last N examples (e.g., last 1 you just added)
yarn eval:codereview:tsjs --filter-first-n 999 --no-cache

# Or quick mode for a sanity check
yarn eval:codereview:light --lang=tsjs
```

---

## Adding a New Language

To add a completely new language (e.g., Go, Rust, Swift):

### 1. Create the `.jsonl` files

```bash
touch evals/promptfoo/datasets_ast/go.jsonl
touch evals/promptfoo/datasets_ast/go_crossfile.jsonl
```

### 2. Register them in `convert-dataset.js`

Open `evals/promptfoo/convert-dataset.js` and add entries to `ALL_DATASETS` (line ~19):

```js
const ALL_DATASETS = {
    tsjs: 'tsjs.jsonl',
    tsjs_crossfile: 'tsjs_crossfile.jsonl',
    react: 'react.jsonl',
    react_crossfile: 'react_crossfile.jsonl',
    python: 'python.jsonl',
    python_crossfile: 'python_crossfile.jsonl',
    java: 'java.jsonl',
    java_crossfile: 'java_crossfile.jsonl',
    ruby: 'ruby.jsonl',
    ruby_crossfile: 'ruby_crossfile.jsonl',
    // ADD THESE:
    go: 'go.jsonl',
    go_crossfile: 'go_crossfile.jsonl',
};
```

### 3. (Optional) Add a yarn shortcut

In `package.json`:

```json
"eval:codereview:go": "cd evals/promptfoo && ./run-eval.sh --lang=go"
```

### 4. Add test cases

Add at least 5-10 examples to `go.jsonl` and 3-5 to `go_crossfile.jsonl` following the format described above. The code goes in `fileContent`, the diff in `patchWithLinesStr`, bugs in `codeSuggestions`.

### 5. Run

```bash
# Run just Go
yarn eval:codereview --lang=go

# Or if you added the shortcut
yarn eval:codereview:go
```

That's it. No other files need to change — `run-eval.sh`, assertions, judge, and analysis all work language-agnostically.

---

## Bug Examples by Complexity

### Simple: Single Bug (TypeScript)

One clear bug — off-by-one in a loop.

```json
{
    "inputs": {
        "inputs": {
            "filePath": "src/utils/paginate.ts",
            "fileContent": "export function paginate<T>(items: T[], page: number, size: number): T[] {\n  const start = page * size;\n  const end = start + size;\n  return items.slice(start, end + 1);\n}\n",
            "patchWithLinesStr": "## file: 'src/utils/paginate.ts'\n\n@@ -0,0 +1,5 @@\n__new hunk__\n1 +export function paginate<T>(items: T[], page: number, size: number): T[] {\n2 +  const start = page * size;\n3 +  const end = start + size;\n4 +  return items.slice(start, end + 1);\n5 +}\n__old hunk__\n",
            "pullRequest": {
                "body": "Add generic pagination helper"
            }
        }
    },
    "outputs": {
        "reference_outputs": {
            "codeSuggestions": [
                {
                    "label": "bug",
                    "relevantFile": "src/utils/paginate.ts",
                    "relevantLinesStart": 4,
                    "relevantLinesEnd": 4,
                    "existingCode": "return items.slice(start, end + 1);",
                    "improvedCode": "return items.slice(start, end);",
                    "suggestionContent": "Array.slice() end index is exclusive, so `end + 1` returns size+1 items per page. paginate([1,2,3,4,5], 0, 2) returns [1,2,3] instead of [1,2].",
                    "oneSentenceSummary": "Off-by-one: slice returns one extra element per page"
                }
            ]
        }
    }
}
```

### Medium: Multi-Bug with Security + Logic (Python)

Three bugs in one file — SQL injection, unbounded query, and a logic inversion.

```json
{
    "inputs": {
        "inputs": {
            "filePath": "src/reports/report_generator.py",
            "fileContent": "import sqlite3\nfrom datetime import datetime\n\nclass ReportGenerator:\n    def __init__(self, db_path: str):\n        self.conn = sqlite3.connect(db_path)\n\n    def get_sales(self, start_date: str, category: str) -> list[dict]:\n        query = f\"SELECT * FROM sales WHERE date >= '{start_date}' AND category = '{category}'\"\n        cursor = self.conn.execute(query)\n        return [dict(row) for row in cursor.fetchall()]\n\n    def get_top_products(self, min_revenue: float) -> list[dict]:\n        query = \"SELECT product, SUM(amount) as total FROM sales GROUP BY product HAVING total >= ?\"\n        cursor = self.conn.execute(query, (min_revenue,))\n        return [dict(row) for row in cursor.fetchall()]\n\n    def is_profitable(self, revenue: float, costs: float) -> bool:\n        return costs > revenue\n",
            "patchWithLinesStr": "## file: 'src/reports/report_generator.py'\n\n@@ -0,0 +1,19 @@\n__new hunk__\n1 +import sqlite3\n2 +from datetime import datetime\n3 +\n4 +class ReportGenerator:\n5 +    def __init__(self, db_path: str):\n6 +        self.conn = sqlite3.connect(db_path)\n7 +\n8 +    def get_sales(self, start_date: str, category: str) -> list[dict]:\n9 +        query = f\"SELECT * FROM sales WHERE date >= '{start_date}' AND category = '{category}'\"\n10 +        cursor = self.conn.execute(query)\n11 +        return [dict(row) for row in cursor.fetchall()]\n12 +\n13 +    def get_top_products(self, min_revenue: float) -> list[dict]:\n14 +        query = \"SELECT product, SUM(amount) as total FROM sales GROUP BY product HAVING total >= ?\"\n15 +        cursor = self.conn.execute(query, (min_revenue,))\n16 +        return [dict(row) for row in cursor.fetchall()]\n17 +\n18 +    def is_profitable(self, revenue: float, costs: float) -> bool:\n19 +        return costs > revenue\n__old hunk__\n",
            "pullRequest": {
                "body": "Add report generation service with sales queries"
            }
        }
    },
    "outputs": {
        "reference_outputs": {
            "codeSuggestions": [
                {
                    "label": "bug",
                    "relevantFile": "src/reports/report_generator.py",
                    "relevantLinesStart": 9,
                    "relevantLinesEnd": 9,
                    "existingCode": "query = f\"SELECT * FROM sales WHERE date >= '{start_date}' AND category = '{category}'\"",
                    "improvedCode": "query = \"SELECT * FROM sales WHERE date >= ? AND category = ?\"\ncursor = self.conn.execute(query, (start_date, category))",
                    "suggestionContent": "SQL injection: start_date and category are interpolated directly into the query via f-string. An attacker passing category=\"'; DROP TABLE sales; --\" can execute arbitrary SQL.",
                    "oneSentenceSummary": "SQL injection via f-string interpolation in get_sales"
                },
                {
                    "label": "bug",
                    "relevantFile": "src/reports/report_generator.py",
                    "relevantLinesStart": 9,
                    "relevantLinesEnd": 11,
                    "existingCode": "cursor = self.conn.execute(query)\nreturn [dict(row) for row in cursor.fetchall()]",
                    "improvedCode": "cursor = self.conn.execute(query + ' LIMIT 10000')\nreturn [dict(row) for row in cursor.fetchall()]",
                    "suggestionContent": "Unbounded query: no LIMIT clause means get_sales can return millions of rows into memory. A broad date range like '2000-01-01' will load the entire sales table, causing OOM.",
                    "oneSentenceSummary": "No LIMIT on sales query can cause OOM on large tables"
                },
                {
                    "label": "bug",
                    "relevantFile": "src/reports/report_generator.py",
                    "relevantLinesStart": 19,
                    "relevantLinesEnd": 19,
                    "existingCode": "return costs > revenue",
                    "improvedCode": "return revenue > costs",
                    "suggestionContent": "Logic inversion: is_profitable returns True when costs exceed revenue, which is the opposite of profitable. is_profitable(revenue=100, costs=200) returns True.",
                    "oneSentenceSummary": "is_profitable returns True when losing money (comparison is inverted)"
                }
            ]
        }
    }
}
```

### Hard: Race Condition + Resource Leak + SSRF (Java)

Four bugs including concurrency, security, and resource management issues.

```json
{
    "inputs": {
        "inputs": {
            "filePath": "src/main/java/com/acme/webhooks/WebhookDispatcher.java",
            "fileContent": "package com.acme.webhooks;\n\nimport java.net.*;\nimport java.net.http.*;\nimport java.util.concurrent.*;\nimport java.util.Map;\n\npublic class WebhookDispatcher {\n    private final Map<String, Integer> retryCounts = new ConcurrentHashMap<>();\n    private final HttpClient client = HttpClient.newHttpClient();\n\n    public void dispatch(String url, String payload) {\n        CompletableFuture.runAsync(() -> sendWithRetry(url, payload));\n    }\n\n    private void sendWithRetry(String url, String payload) {\n        int attempts = 0;\n        while (true) {\n            try {\n                HttpRequest request = HttpRequest.newBuilder()\n                    .uri(URI.create(url))\n                    .header(\"Content-Type\", \"application/json\")\n                    .POST(HttpRequest.BodyPublishers.ofString(payload))\n                    .build();\n                HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());\n                if (response.statusCode() < 400) {\n                    retryCounts.remove(url);\n                    return;\n                }\n            } catch (Exception e) {\n                // retry\n            }\n            attempts++;\n            retryCounts.put(url, attempts);\n            try { Thread.sleep(1000); } catch (InterruptedException ignored) {}\n        }\n    }\n\n    public int getRetryCount(String url) {\n        return retryCounts.getOrDefault(url, 0);\n    }\n}\n",
            "patchWithLinesStr": "## file: 'src/main/java/com/acme/webhooks/WebhookDispatcher.java'\n\n@@ -0,0 +1,43 @@\n__new hunk__\n1 +package com.acme.webhooks;\n2 +\n3 +import java.net.*;\n4 +import java.net.http.*;\n5 +import java.util.concurrent.*;\n6 +import java.util.Map;\n7 +\n8 +public class WebhookDispatcher {\n9 +    private final Map<String, Integer> retryCounts = new ConcurrentHashMap<>();\n10 +    private final HttpClient client = HttpClient.newHttpClient();\n11 +\n12 +    public void dispatch(String url, String payload) {\n13 +        CompletableFuture.runAsync(() -> sendWithRetry(url, payload));\n14 +    }\n15 +\n16 +    private void sendWithRetry(String url, String payload) {\n17 +        int attempts = 0;\n18 +        while (true) {\n19 +            try {\n20 +                HttpRequest request = HttpRequest.newBuilder()\n21 +                    .uri(URI.create(url))\n22 +                    .header(\"Content-Type\", \"application/json\")\n23 +                    .POST(HttpRequest.BodyPublishers.ofString(payload))\n24 +                    .build();\n25 +                HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());\n26 +                if (response.statusCode() < 400) {\n27 +                    retryCounts.remove(url);\n28 +                    return;\n29 +                }\n30 +            } catch (Exception e) {\n31 +                // retry\n32 +            }\n33 +            attempts++;\n34 +            retryCounts.put(url, attempts);\n35 +            try { Thread.sleep(1000); } catch (InterruptedException ignored) {}\n36 +        }\n37 +    }\n38 +\n39 +    public int getRetryCount(String url) {\n40 +        return retryCounts.getOrDefault(url, 0);\n41 +    }\n42 +}\n43 +\n__old hunk__\n",
            "pullRequest": {
                "body": "Add webhook dispatcher with retry support"
            }
        }
    },
    "outputs": {
        "reference_outputs": {
            "codeSuggestions": [
                {
                    "label": "bug",
                    "relevantFile": "src/main/java/com/acme/webhooks/WebhookDispatcher.java",
                    "relevantLinesStart": 21,
                    "relevantLinesEnd": 21,
                    "existingCode": ".uri(URI.create(url))",
                    "improvedCode": "URI target = URI.create(url);\nif (target.getHost().matches(\"(localhost|127\\\\..+|10\\\\..+|169\\\\.254\\\\..+)\")) throw new SecurityException(\"SSRF blocked\");\n// then use target",
                    "suggestionContent": "SSRF: url comes from user input and is passed directly to HttpClient without validation. An attacker can supply http://169.254.169.254/latest/meta-data/ to access cloud metadata, or http://localhost:8080/admin to reach internal services.",
                    "oneSentenceSummary": "SSRF — no validation on webhook URL allows access to internal services"
                },
                {
                    "label": "bug",
                    "relevantFile": "src/main/java/com/acme/webhooks/WebhookDispatcher.java",
                    "relevantLinesStart": 18,
                    "relevantLinesEnd": 36,
                    "existingCode": "while (true) {",
                    "improvedCode": "int maxRetries = 5;\nwhile (attempts < maxRetries) {",
                    "suggestionContent": "Infinite retry: while(true) with no max attempts means a permanently-failing endpoint (e.g., DNS error, permanent 500) will block a thread forever. With CompletableFuture.runAsync using the common ForkJoinPool, this starves the pool over time.",
                    "oneSentenceSummary": "Infinite retry loop blocks thread forever on permanent failures"
                },
                {
                    "label": "bug",
                    "relevantFile": "src/main/java/com/acme/webhooks/WebhookDispatcher.java",
                    "relevantLinesStart": 35,
                    "relevantLinesEnd": 35,
                    "existingCode": "try { Thread.sleep(1000); } catch (InterruptedException ignored) {}",
                    "improvedCode": "try { Thread.sleep(1000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return; }",
                    "suggestionContent": "Swallowed interrupt: catching InterruptedException without re-interrupting the thread means cancellation signals from ExecutorService.shutdownNow() are silently lost. The retry loop will continue running even after the application is trying to shut down.",
                    "oneSentenceSummary": "Swallowed InterruptedException prevents graceful shutdown"
                },
                {
                    "label": "bug",
                    "relevantFile": "src/main/java/com/acme/webhooks/WebhookDispatcher.java",
                    "relevantLinesStart": 13,
                    "relevantLinesEnd": 13,
                    "existingCode": "CompletableFuture.runAsync(() -> sendWithRetry(url, payload));",
                    "improvedCode": "CompletableFuture.runAsync(() -> sendWithRetry(url, payload))\n    .exceptionally(ex -> { logger.error(\"Dispatch failed\", ex); return null; });",
                    "suggestionContent": "Silent failure: CompletableFuture.runAsync returns a future that is never stored or observed. If sendWithRetry throws an unexpected RuntimeException (e.g., URI.create fails on a malformed URL), the exception vanishes silently — no log, no alert, no retry.",
                    "oneSentenceSummary": "Unobserved CompletableFuture silently swallows exceptions"
                }
            ]
        }
    }
}
```

### Cross-File: Renamed Enum Breaks 3 Consumers (TypeScript)

The diff renames enum values. Three separate consumer files still use the old values.

```json
{
    "inputs": {
        "inputs": {
            "filePath": "src/types/order-status.ts",
            "fileContent": "export enum OrderStatus {\n  Pending = 'PENDING',\n  Confirmed = 'CONFIRMED',\n  Shipped = 'DISPATCHED',\n  Delivered = 'DELIVERED',\n  Cancelled = 'VOID',\n}\n",
            "patchWithLinesStr": "## file: 'src/types/order-status.ts'\n@@ -1,7 +1,7 @@\n__new hunk__\n1  export enum OrderStatus {\n2    Pending = 'PENDING',\n3    Confirmed = 'CONFIRMED',\n4 +  Shipped = 'DISPATCHED',\n5    Delivered = 'DELIVERED',\n6 +  Cancelled = 'VOID',\n7  }\n__old hunk__\n1  export enum OrderStatus {\n2    Pending = 'PENDING',\n3    Confirmed = 'CONFIRMED',\n4 -  Shipped = 'SHIPPED',\n5    Delivered = 'DELIVERED',\n6 -  Cancelled = 'CANCELLED',\n7  }",
            "pullRequest": {
                "body": "Align order status enum values with warehouse API naming"
            },
            "crossFileSnippets": [
                {
                    "filePath": "src/services/shipping.service.ts",
                    "relatedSymbol": "ShippingService.markShipped",
                    "rationale": "Compares against hardcoded 'SHIPPED' string",
                    "content": "import { OrderStatus } from '../types/order-status';\n\nexport class ShippingService {\n  async markShipped(orderId: string): Promise<void> {\n    const order = await this.repo.findById(orderId);\n    if (order.status !== 'SHIPPED') {\n      await this.repo.update(orderId, { status: 'SHIPPED' });\n      await this.notifyCustomer(orderId);\n    }\n  }\n}"
                },
                {
                    "filePath": "src/services/refund.service.ts",
                    "relatedSymbol": "RefundService.processRefund",
                    "rationale": "Checks for 'CANCELLED' to allow refunds",
                    "content": "export class RefundService {\n  async processRefund(orderId: string): Promise<boolean> {\n    const order = await this.repo.findById(orderId);\n    if (order.status !== 'CANCELLED') {\n      throw new Error('Can only refund cancelled orders');\n    }\n    return this.paymentGateway.refund(order.chargeId);\n  }\n}"
                },
                {
                    "filePath": "src/analytics/dashboard.ts",
                    "relatedSymbol": "Dashboard.getShippedCount",
                    "rationale": "Filters by 'SHIPPED' and 'CANCELLED' string literals",
                    "content": "export class Dashboard {\n  async getShippedCount(): Promise<number> {\n    return this.db.count('orders', { status: 'SHIPPED' });\n  }\n\n  async getCancelledCount(): Promise<number> {\n    return this.db.count('orders', { status: 'CANCELLED' });\n  }\n}"
                }
            ]
        }
    },
    "outputs": {
        "reference_outputs": {
            "codeSuggestions": [
                {
                    "label": "bug",
                    "relevantFile": "src/types/order-status.ts",
                    "relevantLinesStart": 4,
                    "relevantLinesEnd": 4,
                    "existingCode": "Shipped = 'DISPATCHED',",
                    "improvedCode": "// WARNING: ShippingService and Dashboard still use 'SHIPPED'\nShipped = 'DISPATCHED',",
                    "suggestionContent": "Shipped value changed from 'SHIPPED' to 'DISPATCHED' but ShippingService.markShipped() compares and writes 'SHIPPED', and Dashboard.getShippedCount() filters by 'SHIPPED'. Both will silently stop matching any orders.",
                    "oneSentenceSummary": "Renamed 'SHIPPED' to 'DISPATCHED' breaks ShippingService and Dashboard"
                },
                {
                    "label": "bug",
                    "relevantFile": "src/types/order-status.ts",
                    "relevantLinesStart": 6,
                    "relevantLinesEnd": 6,
                    "existingCode": "Cancelled = 'VOID',",
                    "improvedCode": "// WARNING: RefundService and Dashboard still use 'CANCELLED'\nCancelled = 'VOID',",
                    "suggestionContent": "Cancelled value changed from 'CANCELLED' to 'VOID' but RefundService.processRefund() checks for 'CANCELLED' to allow refunds, and Dashboard.getCancelledCount() counts by 'CANCELLED'. Refunds will always throw and cancelled count will always be 0.",
                    "oneSentenceSummary": "Renamed 'CANCELLED' to 'VOID' breaks RefundService and Dashboard"
                }
            ]
        }
    }
}
```

### Cross-File: Changed Return Type (Python)

A function changes its return type from `dict` to `tuple`. Two callers still destructure as dict.

```json
{
    "inputs": {
        "inputs": {
            "filePath": "src/services/geocoder.py",
            "fileContent": "import requests\n\ndef geocode(address: str) -> tuple[float, float]:\n    resp = requests.get('https://api.geo.example/v1/search', params={'q': address})\n    data = resp.json()\n    return (data['lat'], data['lng'])\n",
            "patchWithLinesStr": "## file: 'src/services/geocoder.py'\n@@ -1,6 +1,6 @@\n__new hunk__\n1  import requests\n2  \n3 +def geocode(address: str) -> tuple[float, float]:\n4      resp = requests.get('https://api.geo.example/v1/search', params={'q': address})\n5      data = resp.json()\n6 +    return (data['lat'], data['lng'])\n__old hunk__\n1  import requests\n2  \n3 -def geocode(address: str) -> dict:\n4      resp = requests.get('https://api.geo.example/v1/search', params={'q': address})\n5      data = resp.json()\n6 -    return {'lat': data['lat'], 'lng': data['lng'], 'formatted': data.get('display_name', '')}",
            "pullRequest": {
                "body": "Simplify geocode return type to just lat/lng tuple"
            },
            "crossFileSnippets": [
                {
                    "filePath": "src/services/delivery_service.py",
                    "relatedSymbol": "DeliveryService.estimate_distance",
                    "rationale": "Accesses .lat and .lng as dict keys on geocode result",
                    "content": "from src.services.geocoder import geocode\n\nclass DeliveryService:\n    def estimate_distance(self, origin: str, dest: str) -> float:\n        origin_loc = geocode(origin)\n        dest_loc = geocode(dest)\n        return haversine(origin_loc['lat'], origin_loc['lng'], dest_loc['lat'], dest_loc['lng'])"
                },
                {
                    "filePath": "src/handlers/store_locator.py",
                    "relatedSymbol": "find_nearest_store",
                    "rationale": "Accesses 'formatted' key that was removed from return value",
                    "content": "from src.services.geocoder import geocode\n\ndef find_nearest_store(address: str) -> dict:\n    location = geocode(address)\n    display = location['formatted']\n    stores = fetch_nearby(location['lat'], location['lng'])\n    return {'address': display, 'stores': stores}"
                }
            ]
        }
    },
    "outputs": {
        "reference_outputs": {
            "codeSuggestions": [
                {
                    "label": "bug",
                    "relevantFile": "src/services/geocoder.py",
                    "relevantLinesStart": 3,
                    "relevantLinesEnd": 6,
                    "existingCode": "def geocode(address: str) -> tuple[float, float]:\n    ...\n    return (data['lat'], data['lng'])",
                    "improvedCode": "# WARNING: DeliveryService and store_locator still access result as dict\ndef geocode(address: str) -> tuple[float, float]:",
                    "suggestionContent": "Return type changed from dict to tuple but DeliveryService.estimate_distance() still accesses result with dict keys (origin_loc['lat'], origin_loc['lng']). Calling geocode() now returns a tuple, so origin_loc['lat'] will raise TypeError: tuple indices must be integers.",
                    "oneSentenceSummary": "Changed return from dict to tuple breaks DeliveryService dict access"
                },
                {
                    "label": "bug",
                    "relevantFile": "src/services/geocoder.py",
                    "relevantLinesStart": 6,
                    "relevantLinesEnd": 6,
                    "existingCode": "return (data['lat'], data['lng'])",
                    "improvedCode": "# WARNING: store_locator accesses location['formatted'] which no longer exists",
                    "suggestionContent": "The 'formatted' field was removed from the return value but store_locator.find_nearest_store() still accesses location['formatted']. This will raise TypeError (tuple has no key access) and also lose the display_name data entirely.",
                    "oneSentenceSummary": "Removed 'formatted' field from return breaks store_locator"
                }
            ]
        }
    }
}
```

---

## Good Bug Patterns Reference

### Normal (single-file)

| Pattern                 | Difficulty | Example                                                    |
| ----------------------- | ---------- | ---------------------------------------------------------- |
| Off-by-one              | Easy       | `i <= max` instead of `i < max`, `slice(0, n+1)`           |
| Logic inversion         | Easy       | `costs > revenue` instead of `revenue > costs`             |
| SQL injection           | Medium     | f-string/template literal in SQL query                     |
| Timing attack           | Medium     | `===` for token comparison instead of constant-time        |
| Race condition          | Hard       | Read-modify-write without locking, TOCTOU                  |
| Resource leak           | Medium     | Unclosed connection in error path, no finally              |
| SSRF                    | Medium     | User-provided URL passed to HTTP client without validation |
| Unbounded query         | Medium     | No LIMIT on database query, OOM on large tables            |
| Silent failure          | Medium     | Swallowed exception, unobserved Promise/Future             |
| Infinite loop           | Medium     | Retry with no max attempts, blocking thread forever        |
| Floating-point currency | Medium     | Using float for money calculations                         |
| Prototype pollution     | Hard       | deepMerge without filtering `__proto__`                    |
| N+1 queries             | Medium     | Bulk fetch then re-query each item in a loop               |
| Missing atomicity       | Hard       | Two operations that should be in a transaction but aren't  |

### Cross-file

| Pattern                    | Difficulty | Example                                                               |
| -------------------------- | ---------- | --------------------------------------------------------------------- |
| Renamed event/key          | Easy       | Registry renames events, callers still emit old names                 |
| Changed string literal     | Easy       | Config value changes, hardcoded strings elsewhere don't update        |
| Removed enum value         | Medium     | Enum drops a variant, consumers still reference it                    |
| Changed function signature | Medium     | New required parameter, callers don't pass it                         |
| Changed return type        | Hard       | dict → tuple, callers still destructure as dict                       |
| Renamed export             | Medium     | Class/function renamed, importers use old name                        |
| Changed interface          | Hard       | Field renamed in a shared interface, implementors use old name        |
| Removed method             | Medium     | Base class removes a method, subclasses still call `super().method()` |

### Tips for writing good bugs

1. **Make them provable.** The judge needs a concrete scenario: "input X → expected Y → actual Z". Style opinions will be rejected.

2. **3-4 bugs per example is the sweet spot.** The existing dataset averages 3.4 bugs per normal file and 3.8 per cross-file. Too few is easy; too many gets noisy.

3. **Mix severity.** Combine a security bug with a logic bug with a resource issue. Realistic code has diverse problems.

4. **For cross-file: 1 snippet per broken contract.** Each `crossFileSnippet` should show exactly one caller/consumer that breaks. Don't dump entire files — include just enough code to see the dependency.

5. **Line numbers must match the diff.** `relevantLinesStart/End` in codeSuggestions must point to the line numbers in `patchWithLinesStr`, not the original `fileContent`.

---

## Running the Eval

```bash
yarn eval:codereview                    # All languages, normal + cross-file
yarn eval:codereview:tsjs               # TS/JS only
yarn eval:codereview:python             # Python only
yarn eval:codereview:java               # Java only
yarn eval:codereview:ruby               # Ruby only
yarn eval:codereview --dataset-type=normal     # Normal only (all langs)
yarn eval:codereview --dataset-type=crossfile  # Cross-file only (all langs)
yarn eval:codereview:light              # Quick: 5 examples, no cache
yarn eval:codereview:bench              # Benchmark: 5 examples x 3 repeats
yarn eval:codereview:bench:full         # Heavy: all examples x 3 repeats
```

Extra flags are forwarded to promptfoo:

```bash
yarn eval:codereview:tsjs --no-cache --filter-first-n 3
yarn eval:codereview --filter-providers "openai:gpt-5.2"
```

View results in the web UI:

```bash
promptfoo view
```

---

## Analyzing Results

```bash
yarn eval:codereview:analyze
```

Reads from `results/output-normal.json` and `results/output-crossfile.json`.

---

## Scoring and Metrics

Each test runs 3 assertions:

| Assertion     | Type          | What it checks                                             |
| ------------- | ------------- | ---------------------------------------------------------- |
| Parse         | Deterministic | Can the production parser handle the output?               |
| Judge         | LLM-based     | Sonnet + GPT evaluate bug coverage and suggestion validity |
| Line Accuracy | Deterministic | IoU of predicted vs reference line ranges                  |

### Judge formula

```
judge_score  = (coverage * 0.5) + (validity * 0.5)
final_score  = avg(sonnet_judge_score, gpt_judge_score)
pass         = final_score >= 0.7
```

### Metrics

| Metric   | Description                                                 |
| -------- | ----------------------------------------------------------- |
| Score    | Average of both judges                                      |
| Coverage | % of reference bugs found by at least one valid suggestion  |
| Validity | % of model suggestions that are real, provable bugs         |
| Line Acc | Avg IoU of predicted vs reference line ranges (unfound = 0) |
| Avg IoU  | Avg IoU only for bugs the model found                       |
| Exact    | % with exact line range match                               |
| Within 3 | % within 3 lines of reference                               |
| Latency  | p50 and p95 response time                                   |

---

## Models and Providers

Configured in `promptfoo.yaml`:

| Model                    | Provider              |
| ------------------------ | --------------------- |
| Gemini 2.5 Pro           | Google                |
| Gemini 3.1 Pro (preview) | Google                |
| Gemini 3 Flash (preview) | Google                |
| Claude Sonnet 4.5        | Anthropic             |
| Claude Haiku 4.5         | Anthropic             |
| GPT-5.2                  | OpenAI                |
| Kimi K2.5                | Moonshot (OpenRouter) |
| GLM 5                    | Z-AI (OpenRouter)     |

To add a provider, edit `promptfoo.yaml` and add the API key export to `run-eval.sh`:

```bash
# run-eval.sh maps .env names to promptfoo names:
OPENAI_API_KEY     ← API_OPEN_AI_API_KEY
ANTHROPIC_API_KEY  ← API_ANTHROPIC_API_KEY
GOOGLE_API_KEY     ← API_GOOGLE_AI_API_KEY
OPENROUTER_API_KEY ← API_OPENROUTER_KEY
```

---

## Regenerating the Prompt

If the production code review prompt changes:

```bash
yarn eval:codereview:generate-prompt
```

This imports `prompt_codereview_system_gemini_v2` from the codebase and writes `generated-prompt.json`.

---

## Troubleshooting

| Problem                           | Fix                                                               |
| --------------------------------- | ----------------------------------------------------------------- |
| `promptfoo: command not found`    | `npm install -g promptfoo`                                        |
| API key errors                    | Check `.env` has the keys listed above                            |
| `PARSE_FAIL`                      | Model output not parseable — check `promptfoo view`               |
| `JUDGE_ERROR`                     | Missing `API_ANTHROPIC_API_KEY` or `API_OPEN_AI_API_KEY`          |
| Line accuracy all zeros           | `relevantLinesStart/End` don't match diff line numbers            |
| `Warning: <file>.jsonl not found` | File missing from `datasets_ast/`                                 |
| `codereview-tests.json` empty     | Check `--lang` and `--dataset-type` flags                         |
| Cross-file context not in prompt  | `crossFileSnippets` must be inside `inputs.inputs`, not top level |
| Invalid JSON in dataset           | Validate with the `node -e` command in Step 7 above               |
