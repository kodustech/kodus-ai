import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from collector import DockerClient, SampleError, add_cpu_rate, main, numeric_stats, open_output, parse_args, snapshot


def stats(total=1_000_000_000, identity='a' * 64):
    return {
        'id': identity,
        'cpu_stats': {'cpu_usage': {'total_usage': total}},
        'memory_stats': {'usage': 100, 'limit': 1024, 'stats': {'inactive_file': 20}},
        'pids_stats': {'current': 3},
        'networks': {'eth0': {'rx_bytes': 10, 'tx_bytes': 12}},
        'name': 'SECRET', 'labels': {'token': 'SECRET'}, 'args': ['SECRET'],
    }


class CollectorTests(unittest.TestCase):
    def test_output_filters_unknown_fields_and_includes_numeric_memory(self):
        sample = numeric_stats('builder', stats())
        self.assertNotIn('SECRET', json.dumps(sample))
        self.assertEqual(sample['memoryWorkingSetBytes'], 80)
        self.assertEqual(sample['networkRxBytes'], 10)
        self.assertEqual(sample['cpuTotalNs'], 1_000_000_000)

    def test_invalid_numbers_and_empty_stats_are_gaps(self):
        for payload in [{}, {**stats(), 'memory_stats': {}},
                        {**stats(), 'cpu_stats': {'cpu_usage': {'total_usage': float('nan')}}}]:
            sample = numeric_stats('builder', payload)
            self.assertEqual(sample['error']['code'], 'empty_stats')
            self.assertNotIn('cpuTotalNs', sample)

    def test_timeout_preserves_previous_valid_sample(self):
        previous = {}
        add_cpu_rate(numeric_stats('builder', stats()), previous, 1)
        add_cpu_rate({'name': 'builder', 'error': {'code': 'timeout'}}, previous, 2)
        resumed = numeric_stats('builder', stats(5_000_000_000))
        add_cpu_rate(resumed, previous, 5)
        self.assertEqual(resumed['cpuCoresInterval'], 1)
        self.assertEqual(resumed['cpuIntervalSeconds'], 4)

    def test_empty_stats_preserve_previous_valid_sample(self):
        previous = {}
        add_cpu_rate(numeric_stats('builder', stats()), previous, 1)
        add_cpu_rate(numeric_stats('builder', {}), previous, 2)
        resumed = numeric_stats('builder', stats(5_000_000_000))
        add_cpu_rate(resumed, previous, 5)
        self.assertEqual(resumed['cpuCoresInterval'], 1)

    def test_counter_reset_and_container_replacement_flag_a_gap(self):
        for changed in [stats(1), stats(1, 'b' * 64)]:
            previous = {}
            add_cpu_rate(numeric_stats('builder', stats()), previous, 1)
            reset = numeric_stats('builder', changed)
            add_cpu_rate(reset, previous, 2)
            self.assertTrue(reset['cpuCounterReset'])
            self.assertNotIn('cpuCoresInterval', reset)
            resumed = numeric_stats('builder', stats(1_000_000_001, changed['id']))
            add_cpu_rate(resumed, previous, 3)
            self.assertEqual(resumed['cpuCoresInterval'], 1)

    def test_nonpositive_clock_interval_is_a_gap(self):
        previous = {}
        add_cpu_rate(numeric_stats('builder', stats()), previous, 1)
        sample = numeric_stats('builder', stats(2_000_000_000))
        add_cpu_rate(sample, previous, 1)
        self.assertTrue(sample['cpuClockGap'])
        self.assertNotIn('cpuCoresInterval', sample)

    def test_one_timeout_does_not_break_other_targets_or_expose_error_text(self):
        class Client:
            def stats(self, name):
                if name == 'slow':
                    raise TimeoutError('SECRET response')
                return stats()
        samples = snapshot(Client(), ['slow', 'healthy'], {}, lambda: 1)
        self.assertEqual(samples[0], {'name': 'slow', 'error': {'code': 'timeout'}})
        self.assertEqual(samples[1]['cpuTotalNs'], 1_000_000_000)
        self.assertNotIn('SECRET', json.dumps(samples))

    def test_output_is_exclusive_and_private(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'samples.jsonl')
            with open_output(path) as output:
                output.write('{}\n')
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                open_output(path)
            self.assertEqual(Path(path).read_text(), '{}\n')

    def test_cli_bounds_and_explicit_targets(self):
        for args in [[], ['--container', '../secret'], ['--container', 'ok', '--duration', '7201'],
                     ['--container', 'ok', '--duration', 'nan'], ['--container', 'ok', '--interval', '0']]:
            with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
                parse_args(['--socket', '/tmp/docker.sock', *args])
        args = parse_args(['--socket', '/tmp/docker.sock', '--container', 'builder', '--duration', '0'])
        self.assertEqual(args.container, ['builder'])
        self.assertEqual(args.duration, 0)

    def test_negotiates_version_and_requests_only_target_stats(self):
        paths, closed = [], []
        class Connection:
            def __init__(self, path, timeout):
                self.status = 200
            def request(self, method, path):
                self.path = path
                paths.append((method, path))
            def getresponse(self):
                return self
            def read(self, limit):
                value = {'ApiVersion': '1.53', 'Secret': 'SECRET'} if self.path == '/version' else stats()
                return json.dumps(value).encode()
            def close(self):
                closed.append(True)
        client = DockerClient('/tmp/docker.sock', connection=Connection)
        client.negotiate()
        sample = snapshot(client, ['builder'], {}, lambda: 1)[0]
        self.assertNotIn('SECRET', json.dumps(sample))
        self.assertEqual(paths, [('GET', '/version'), ('GET', '/v1.53/containers/builder/stats?stream=false&one-shot=true')])
        self.assertEqual(len(closed), 2)

    def test_http_error_is_code_and_status_only_and_body_is_never_read(self):
        class Connection:
            status = 403
            def __init__(self, path, timeout):
                pass
            def request(self, method, path):
                pass
            def getresponse(self):
                return self
            def read(self, limit):
                raise AssertionError('error body contains SECRET')
            def close(self):
                pass
        client = DockerClient('/tmp/docker.sock', connection=Connection)
        client.version = '1.53'
        result = snapshot(client, ['builder'], {}, lambda: 1)
        self.assertEqual(result, [{'name': 'builder', 'error': {'code': 'http_status', 'status': 403}}])

    def test_invalid_api_version_is_rejected(self):
        client = DockerClient('/tmp/docker.sock')
        client.get = lambda path: {'ApiVersion': '../SECRET'}
        with self.assertRaises(SampleError) as caught:
            client.negotiate()
        self.assertEqual(caught.exception.code, 'invalid_api_version')

    def test_cli_fails_when_every_explicit_target_errors_but_keeps_error_rows(self):
        class Client:
            def negotiate(self):
                pass
            def stats(self, name):
                raise SampleError('http_status', 404)
        output = io.StringIO()
        with patch('collector.DockerClient', return_value=Client()), redirect_stdout(output):
            code = main(['--socket', '/tmp/docker.sock', '--container', 'missing', '--duration', '0'])
        self.assertNotEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())['samples'], [
            {'name': 'missing', 'error': {'code': 'http_status', 'status': 404}},
        ])

    def test_cli_succeeds_for_mixed_targets_including_zero_network_counters(self):
        class Client:
            def negotiate(self):
                pass
            def stats(self, name):
                if name == 'missing':
                    raise SampleError('http_status', 404)
                return {**stats(), 'networks': {}}
        output = io.StringIO()
        with patch('collector.DockerClient', return_value=Client()), redirect_stdout(output):
            code = main(['--socket', '/tmp/docker.sock', '--container', 'healthy',
                         '--container', 'missing', '--duration', '0'])
        self.assertEqual(code, 0)
        rows = json.loads(output.getvalue())['samples']
        self.assertEqual(rows[0]['networkRxBytes'], 0)
        self.assertEqual(rows[0]['cpuTotalNs'], 1_000_000_000)
        self.assertNotIn('cpuCoresInterval', rows[0])
        self.assertEqual(rows[1]['error']['status'], 404)

    def test_cli_retains_success_if_a_later_snapshot_has_only_errors(self):
        clock = [0]
        class Client:
            def negotiate(self):
                pass
            def stats(self, name):
                clock[0] += 1
                if clock[0] > 1:
                    raise SampleError('http_status', 404)
                return stats()
        output = io.StringIO()
        with patch('collector.DockerClient', return_value=Client()), redirect_stdout(output), \
                patch('collector.time.monotonic', side_effect=lambda: clock[0]), \
                patch('collector.time.sleep'):
            code = main(['--socket', '/tmp/docker.sock', '--container', 'sometimes', '--duration', '2'])
        rows = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(code, 0)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['samples'][0]['cpuTotalNs'], 1_000_000_000)
        self.assertEqual(rows[1]['samples'][0]['error']['status'], 404)


if __name__ == '__main__':
    unittest.main()
