// Writes the Go cell's golden file for redact.Variants from the TS original
// (secretVariants/maskSecrets), so the port stays faithful. Usage:
//   ts-node -r tsconfig-paths/register --transpile-only libs/runtime/redaction/scripts/dump-variants-golden.ts
import { writeFileSync } from 'node:fs';
import { maskSecrets, secretVariants } from '@libs/code-review/infrastructure/agents/custom-agent-cli/cli-output-mask';
const secrets = ['ghs_DownloadToken0123456789abcdef', "p@ss w/rd+&<>'\"!~*()", 'ünïcødé-sëcret', 'emoji😀key-1234', 'line\nbreak\ttab\u0001ctl', 'short', 'ab', 'x'];
const cases = secrets.map((s) => ({ secret: s, variants: secretVariants(s).sort() }));
const text = secrets.map((s) => `[${s}] b64=${Buffer.from(s).toString('base64')} pct=${encodeURIComponent(s)} json=${JSON.stringify(s)}`).join('\n');
writeFileSync(process.argv[2] ?? 'apps/runtime-cell/internal/redact/testdata/ts-variants.json', JSON.stringify({ generatedBy: 'secretVariants/maskSecrets in libs/code-review/infrastructure/agents/custom-agent-cli/cli-output-mask.ts', cases, mask: { text, secrets, masked: maskSecrets(text, secrets) } }, null, 2) + '\n');
