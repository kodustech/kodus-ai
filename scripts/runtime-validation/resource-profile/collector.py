"""Passive Docker stats over an explicitly selected Unix socket (stdlib only)."""
import argparse
import concurrent.futures
import datetime
import http.client
import json
import math
import os
import re
import socket
import sys
import time
from contextlib import nullcontext

TARGET = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')
IDENTITY = re.compile(r'[a-f0-9]{64}\Z')
VERSION = re.compile(r'[0-9]{1,3}\.[0-9]{1,3}\Z')
MAX_BODY_BYTES = 1_048_576


class SampleError(Exception):
    def __init__(self, code, status=None):
        self.code, self.status = code, status


def error_row(name, error):
    code = error.code if isinstance(error, SampleError) else (
        'timeout' if isinstance(error, TimeoutError) else 'unavailable')
    result = {'code': code}
    if isinstance(error, SampleError) and error.status is not None:
        result['status'] = error.status
    return {'name': name, 'error': result}


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__('localhost', timeout=timeout)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class DockerClient:
    def __init__(self, path, timeout=3, connection=UnixHTTP):
        self.path, self.timeout, self.connection = path, timeout, connection
        self.version = None

    def get(self, path):
        conn = self.connection(self.path, self.timeout)
        try:
            conn.request('GET', path)
            response = conn.getresponse()
            if response.status != 200:
                raise SampleError('http_status', response.status)
            body = response.read(MAX_BODY_BYTES + 1)
            if len(body) > MAX_BODY_BYTES:
                raise SampleError('response_too_large')
            try:
                value = json.loads(body)
            except (ValueError, UnicodeError):
                raise SampleError('invalid_json') from None
            if not isinstance(value, dict):
                raise SampleError('invalid_response')
            return value
        finally:
            conn.close()

    def negotiate(self):
        version = self.get('/version').get('ApiVersion')
        if not isinstance(version, str) or not VERSION.fullmatch(version):
            raise SampleError('invalid_api_version')
        self.version = version

    def stats(self, name):
        if not TARGET.fullmatch(name) or self.version is None:
            raise SampleError('invalid_target')
        return self.get(f'/v{self.version}/containers/{name}/stats?stream=false&one-shot=true')


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def numeric_stats(name, payload):
    try:
        identity = payload.get('id')
        memory = payload.get('memory_stats', {})
        total = payload.get('cpu_stats', {}).get('cpu_usage', {}).get('total_usage')
        if not isinstance(identity, str) or not IDENTITY.fullmatch(identity) or not all(
                number(v) for v in (total, memory.get('usage'), memory.get('limit'))):
            raise SampleError('empty_stats')
        result = {'name': name, 'id': identity, 'cpuTotalNs': total,
                  'memoryUsageBytes': memory['usage'], 'memoryLimitBytes': memory['limit']}
        cache = memory.get('stats', {}).get('inactive_file', memory.get('stats', {}).get('total_inactive_file'))
        if number(cache):
            result.update(memoryCacheBytes=cache, memoryWorkingSetBytes=max(0, memory['usage'] - cache))
        pids = payload.get('pids_stats', {}).get('current')
        if number(pids):
            result['pids'] = pids
        networks = payload.get('networks')
        if isinstance(networks, dict):
            for source, field in [('rx_bytes', 'networkRxBytes'), ('tx_bytes', 'networkTxBytes')]:
                values = [v.get(source) for v in networks.values() if isinstance(v, dict)]
                if len(values) == len(networks) and all(number(v) for v in values):
                    result[field] = sum(values)
        return result
    except (SampleError, AttributeError, TypeError):
        return error_row(name, SampleError('empty_stats'))


def add_cpu_rate(sample, previous, now):
    if 'error' in sample:
        return
    name, identity, total = sample['name'], sample['id'], sample['cpuTotalNs']
    old = previous.get(name)
    if old:
        if identity != old[0] or total < old[1]:
            sample['cpuCounterReset'] = True
        elif now <= old[2]:
            sample['cpuClockGap'] = True
            return
        else:
            sample['cpuIntervalSeconds'] = now - old[2]
            sample['cpuCoresInterval'] = (total - old[1]) / 1e9 / (now - old[2])
    previous[name] = (identity, total, now)


def snapshot(client, names, previous, clock=time.monotonic):
    def sample(name):
        try:
            result = numeric_stats(name, client.stats(name))
        except Exception as error:
            result = error_row(name, error)
        return result, clock()
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(names))) as pool:
        rows = list(pool.map(sample, names))
    for row, at in rows:
        add_cpu_rate(row, previous, at)
    return [row for row, _ in rows]


def open_output(path):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    return os.fdopen(fd, 'w', encoding='utf-8', buffering=1)


class Parser(argparse.ArgumentParser):
    def error(self, message):
        print(json.dumps({'error': {'code': 'invalid_arguments'}}), file=sys.stderr)
        raise SystemExit(2)


def parse_args(args=None):
    parser = Parser(description=__doc__)
    parser.add_argument('--socket', required=True)
    parser.add_argument('--container', action='append', required=True)
    parser.add_argument('--duration', type=float, default=60, help='seconds; 0 takes one snapshot, max 7200')
    parser.add_argument('--interval', type=float, default=2)
    parser.add_argument('--timeout', type=float, default=3)
    parser.add_argument('--output', help='new JSONL file, created exclusively with mode 0600; default stdout')
    options = parser.parse_args(args)
    if (not os.path.isabs(options.socket) or len(options.container) > 16 or
            len(set(options.container)) != len(options.container) or
            any(not TARGET.fullmatch(name) for name in options.container) or
            not math.isfinite(options.duration) or not 0 <= options.duration <= 7200 or
            not math.isfinite(options.interval) or not 0.2 <= options.interval <= 300 or
            not math.isfinite(options.timeout) or not 0.1 <= options.timeout <= 30):
        parser.error('bounds')
    return options


def main(args=None):
    options = parse_args(args)
    try:
        context = open_output(options.output) if options.output else nullcontext(sys.stdout)
        with context as output:
            client = DockerClient(options.socket, options.timeout)
            client.negotiate()
            previous, start, measured = {}, time.monotonic(), False
            while True:
                began = time.monotonic()
                samples = snapshot(client, options.container, previous)
                measured = measured or any('error' not in sample for sample in samples)
                row = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                       'elapsedSeconds': time.monotonic() - start, 'samples': samples}
                print(json.dumps(row, allow_nan=False), file=output, flush=True)
                remaining = options.duration - (time.monotonic() - start)
                if remaining <= 0:
                    break
                time.sleep(min(remaining, max(0, options.interval - (time.monotonic() - began))))
                if time.monotonic() - start >= options.duration:
                    break
        return 0 if measured else 1
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        print(json.dumps(error_row('collector', error)), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
