import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import YAML from 'yaml';

import { promLabel, promMetricName, TAXONOMY } from '@libs/runtime/telemetry/catalog';

// The alert rules and the dashboards read only what the taxonomy names, every
// alert has its runbook entry and a promtool test. promtool itself checks and
// tests the rules (scripts/runtime/test-alert-rules.sh); this keeps the three
// in step with libs/runtime/telemetry/taxonomy.json.

const ROOT = join(__dirname, '../../../../..');
const OBS = join(ROOT, 'apps/runtime/observability');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const rules = YAML.parse(read('apps/runtime/observability/prometheus/runtime-alerts.rules.yml')) as { groups: Array<{ rules: Array<{ alert?: string; record?: string; expr: string; annotations?: Record<string, string> }> }> };
const settings = YAML.parse(read('apps/runtime/observability/prometheus/runtime-settings.rules.yml')) as typeof rules;
const all = [...rules.groups, ...settings.groups].flatMap((g) => g.rules);
const alerts = all.filter((r) => r.alert);
const recorded = new Set(all.filter((r) => r.record).map((r) => r.record!));
const dashboards = readdirSync(join(OBS, 'grafana'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, json: JSON.parse(readFileSync(join(OBS, 'grafana', f), 'utf8')) as { uid: string; panels: Array<{ title: string; targets?: Array<{ expr: string }> }> } }));
const dashboardExprs = dashboards.flatMap((d) => d.json.panels.flatMap((p) => (p.targets ?? []).map((t) => ({ where: `${d.file} · ${p.title}`, expr: t.expr }))));
const exprs = [...alerts.map((a) => ({ where: a.alert!, expr: a.expr })), ...all.filter((r) => r.record).map((r) => ({ where: r.record!, expr: r.expr })), ...dashboardExprs];

const KNOWN_METRICS = new Set(Object.keys(TAXONOMY.metrics).map(promMetricName));
const KNOWN_LABELS = new Set([...Object.keys(TAXONOMY.attributes).map(promLabel), ...Object.keys(TAXONOMY.metricLocalLabels), 'le', 'instance', 'job']);
const base = (series: string) => series.replace(/_(bucket|sum|count)$/, '');

describe('alerts and dashboards as code', () => {
    it('read only metrics the taxonomy names, or the recording rules', () => {
        const unknown = exprs.flatMap(({ where, expr }) =>
            [...expr.matchAll(/\b((?:runtime|cell|gen_ai|kodus_egress)_[a-z0-9_]+|kodus_runtime:[a-z0-9_:]+)/g)]
                .map((m) => m[1])
                .filter((name) => !KNOWN_LABELS.has(name) && !KNOWN_METRICS.has(name) && !KNOWN_METRICS.has(base(name)) && !recorded.has(name))
                .map((name) => `${where}: ${name}`),
        );
        expect(unknown).toEqual([]);
    });

    it('group and select only by taxonomy labels', () => {
        const unknown = exprs.flatMap(({ where, expr }) => {
            const grouped = [...expr.matchAll(/\b(?:by|without)\s*\(([^)]*)\)/g)].flatMap((m) => m[1].split(',').map((l) => l.trim()).filter(Boolean));
            const selected = [...expr.matchAll(/([a-z_]+)\s*(?:=~|!~|!=|=)\s*"/g)].map((m) => m[1]);
            return [...grouped, ...selected].filter((l) => !KNOWN_LABELS.has(l)).map((l) => `${where}: ${l}`);
        });
        expect(unknown).toEqual([]);
    });

    it('link every alert to its runbook entry, and test every alert with promtool', () => {
        const runbook = read('docs/runtime/alerts.md');
        const anchors = new Set([...runbook.matchAll(/^#{2,3} (.+)$/gm)].map((m) => m[1].toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-')));
        const tests = read('apps/runtime/observability/prometheus/tests/runtime-alerts.test.yml');
        expect(alerts.length).toBeGreaterThan(10);
        for (const a of alerts) {
            const url = a.annotations?.runbook_url ?? '';
            expect({ alert: a.alert, runbook: url.endsWith(`docs/runtime/alerts.md#${a.alert!.toLowerCase()}`) && anchors.has(a.alert!.toLowerCase()) }).toEqual({ alert: a.alert, runbook: true });
            expect({ alert: a.alert, tested: tests.includes(`alertname: ${a.alert}`) }).toEqual({ alert: a.alert, tested: true });
        }
    });

    it('cover the four dashboards: overview, cost, cells, stuck and errors', () => {
        expect(dashboards.map((d) => d.json.uid).sort()).toEqual(['kody-runtime-cells', 'kody-runtime-cost', 'kody-runtime-overview', 'kody-runtime-stuck-errors']);
    });
});
