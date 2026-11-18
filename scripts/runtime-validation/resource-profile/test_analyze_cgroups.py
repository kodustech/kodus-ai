import copy
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from analyze_cgroups import AnalysisError, analyze, main, validate_windows


def sample(at, cpu, memory=100, identity='1:2', name='claims', **extra):
    return {'name': name, 'id': identity, 'atMonotonicSeconds': at,
            'cpuTotalNs': cpu * 1_000_000_000, 'memoryCurrentBytes': memory, **extra}


def rows(*samples):
    return [{'samples': [value]} for value in samples]


def windows(start=1, end=5):
    return {'version': 1, 'windows': [{'name': 'replay', 'startMonotonicSeconds': start,
                                     'endMonotonicSeconds': end}]}


def component(report, index=0):
    return report['windows'][0]['components'][index]


class AnalyzeTests(unittest.TestCase):
    def test_only_full_counter_intervals_inside_window_count_no_prorating(self):
        report = analyze(rows(sample(0, 0), sample(2, 4, 200), sample(4, 6, 150),
                              sample(6, 100, 999)), windows(), ['claims'])
        item = component(report)
        self.assertEqual(item['cpuSeconds'], 2)
        self.assertEqual(item['cpuCoverageSeconds'], 2)
        self.assertEqual(item['cpuCoverageFraction'], .5)
        self.assertEqual(item['meanCpuCores'], 1)
        self.assertEqual(item['sampledChargedPeakBytes'], 200)
        self.assertEqual(item['cpuIntervals'], 1)

    def test_reset_and_replaced_identity_do_not_become_negative_or_spike(self):
        report = analyze(rows(sample(1, 5), sample(2, 1), sample(3, 20, identity='1:3'),
                              sample(4, 21, identity='1:3')), windows(), ['claims'])
        item = component(report)
        self.assertEqual(item['counterResets'], 2)
        self.assertEqual(item['cpuSeconds'], 1)
        self.assertEqual(item['cpuCoverageSeconds'], 1)

    def test_error_gap_retains_last_counter_and_is_visible(self):
        error = {'name': 'claims', 'atMonotonicSeconds': 2, 'error': {'code': 'SECRET'}}
        report = analyze(rows(sample(1, 1), error, sample(3, 3)), windows(), ['claims'])
        self.assertEqual(component(report)['errorSamples'], 1)
        self.assertEqual(component(report)['cpuCoverageSeconds'], 2)
        self.assertNotIn('SECRET', json.dumps(report))

    def test_no_interval_is_unknown_but_a_measured_zero_is_zero(self):
        one = component(analyze(rows(sample(2, 0)), windows(), ['claims']))
        self.assertIsNone(one['cpuSeconds'])
        self.assertIsNone(one['meanCpuCores'])
        zero = component(analyze(rows(sample(1, 0), sample(3, 0)), windows(), ['claims']))
        self.assertEqual(zero['cpuSeconds'], 0)

    def test_clock_gap_does_not_replace_valid_baseline(self):
        report = analyze(rows(sample(1, 1), sample(1, 100), sample(3, 3)), windows(), ['claims'])
        self.assertEqual(component(report)['clockGaps'], 1)
        self.assertEqual(component(report)['cpuSeconds'], 2)

    def test_unknown_and_missing_components_stay_unknown_not_zero(self):
        report = analyze(rows(sample(2, 1)), windows(), ['claims', 'browser'])
        self.assertIsNone(component(report, 1)['sampledChargedPeakBytes'])
        self.assertEqual(component(report, 1)['samples'], 0)

    def test_hierarchy_is_reported_per_component_never_summed(self):
        data = [{'samples': [sample(2, 1, 300), sample(2, 1, 200, name='browser')],
                 'accounting': {'includedInTotal': ['claims'], 'breakdownOnly': ['browser']}}]
        report = analyze(data, windows(), ['claims', 'browser'])
        self.assertEqual(component(report)['sampledChargedPeakBytes'], 300)
        self.assertEqual(component(report, 1)['sampledChargedPeakBytes'], 200)
        self.assertNotIn('totalMemoryBytes', report)
        self.assertNotIn('p99', json.dumps(report))

    def test_throttling_and_oom_are_delta_counters_not_lifetime_totals(self):
        first = sample(1, 0, cpuStat={'throttled_usec': 100, 'nr_throttled': 10},
                       memoryEvents={'oom': 2, 'oom_kill': 1})
        last = sample(3, 1, cpuStat={'throttled_usec': 500100, 'nr_throttled': 12},
                      memoryEvents={'oom': 3, 'oom_kill': 1})
        item = component(analyze(rows(first, last), windows(), ['claims']))
        self.assertEqual(item['throttledSeconds'], .5)
        self.assertEqual(item['throttledPeriods'], 2)
        self.assertEqual(item['oomEvents'], 1)
        self.assertEqual(item['oomKillEvents'], 0)

    def test_absent_optional_counters_remain_unknown(self):
        item = component(analyze(rows(sample(1, 0), sample(3, 1)), windows(), ['claims']))
        self.assertIsNone(item['throttledSeconds'])
        self.assertIsNone(item['oomEvents'])

    def test_optional_counter_coverage_exposes_missing_and_reset_intervals(self):
        data = rows(sample(1, 0, memoryEvents={'oom': 10}),
                    sample(2, 1, memoryEvents={'oom': 11}), sample(3, 2),
                    sample(4, 3, memoryEvents={'oom': 0}),
                    sample(5, 4, memoryEvents={'oom': 0}))
        item = component(analyze(data, windows(), ['claims']))
        self.assertEqual(item['cpuCoverageSeconds'], 4)
        self.assertEqual(item['oomEvents'], 1)
        self.assertEqual(item['counterCoverageSeconds']['oomEvents'], 2)
        self.assertEqual(item['counterCoverageSeconds']['throttledSeconds'], 0)

    def test_huge_timestamp_refuses_without_overflow(self):
        with self.assertRaises(AnalysisError):
            analyze(rows(sample(10**1000, 1)), windows(), ['claims'])

    def test_subnormal_interval_refuses_nonfinite_output_with_fixed_diagnostic(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root/'samples.jsonl'; manifest = root/'windows.json'
            source.write_text('\n'.join(json.dumps(row) for row in rows(sample(0, 0), sample(5e-324, 1))))
            manifest.write_text(json.dumps(windows(0, 1)))
            with redirect_stderr(io.StringIO()) as error, redirect_stdout(io.StringIO()) as output:
                result = main(['--samples', str(source), '--windows', str(manifest), '--component', 'claims'])
            self.assertEqual(result, 2)
            self.assertEqual(output.getvalue(), '')
            self.assertEqual(json.loads(error.getvalue()), {'error': {'code': 'analysis_refused'}})

    def test_invalid_windows_and_component_selection_refuse(self):
        for value in [windows(3, 1), windows(1, float('nan')), {'version': True, 'windows': []},
                      {**windows(), 'token': 'SECRET'}]:
            with self.assertRaises(AnalysisError): validate_windows(value)
        for selected in [[], ['claims', 'claims'], ['../SECRET']]:
            with self.assertRaises(AnalysisError): analyze([], windows(), selected)

    def test_invalid_samples_and_duplicate_component_refuse(self):
        for value in [sample(2, -1), sample(float('inf'), 1), {**sample(2, 1), 'cpuTotalNs': True},
                      sample(2, 1, memory=True), sample(2, 1, identity='SECRET')]:
            with self.assertRaises(AnalysisError): analyze(rows(value), windows(), ['claims'])
        with self.assertRaises(AnalysisError):
            analyze([{'samples': [sample(1, 1), sample(2, 2)]}], windows(), ['claims'])

    def test_cli_private_exclusive_output_and_sanitized_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root/'samples.jsonl'; manifest = root/'windows.json'; out = root/'result.json'
            source.write_text('\n'.join(json.dumps(row) for row in rows(sample(1, 0), sample(3, 1))))
            manifest.write_text(json.dumps(windows()))
            args = ['--samples', str(source), '--windows', str(manifest), '--component', 'claims', '--output', str(out)]
            self.assertEqual(main(args), 0)
            self.assertEqual(os.stat(out).st_mode & 0o777, 0o600)
            before = out.read_bytes()
            with redirect_stderr(io.StringIO()) as error: self.assertEqual(main(args), 2)
            self.assertEqual(out.read_bytes(), before)
            source.write_text('{"SECRET":')
            with redirect_stderr(error), redirect_stdout(io.StringIO()):
                self.assertEqual(main(args[:-2]), 2)
            self.assertNotIn('SECRET', error.getvalue())

    def test_cli_refuses_duplicate_keys_symlink_and_empty_capture(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root/'samples.jsonl'; manifest = root/'windows.json'
            manifest.write_text(json.dumps(windows()))
            args = ['--samples', str(source), '--windows', str(manifest), '--component', 'claims']
            source.write_text('{"samples":[],"samples":[]}')
            with redirect_stderr(io.StringIO()), redirect_stdout(io.StringIO()): self.assertEqual(main(args), 2)
            source.unlink(); source.symlink_to(manifest)
            with redirect_stderr(io.StringIO()), redirect_stdout(io.StringIO()): self.assertEqual(main(args), 2)
            source.unlink(); source.write_text('')
            with redirect_stdout(io.StringIO()) as output: self.assertEqual(main(args), 1)
            self.assertIsNone(component(json.loads(output.getvalue()))['cpuSeconds'])

    def test_analyzer_does_not_mutate_capture_or_windows(self):
        data, config = rows(sample(1, 0), sample(3, 1)), windows()
        before = copy.deepcopy([data, config])
        analyze(data, config, ['claims'])
        self.assertEqual([data, config], before)


if __name__ == '__main__': unittest.main()
