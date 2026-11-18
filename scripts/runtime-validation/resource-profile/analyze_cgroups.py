"""Offline per-component cgroup counters in explicit monotonic time windows."""
import hashlib
import json
import math
import os
import re
import stat
import sys
from contextlib import nullcontext

from collector import Parser, open_output

NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z')
IDENTITY = re.compile(r'[0-9]{1,20}:[0-9]{1,20}\Z')
MAX_CAPTURE_BYTES = 64 * 1024 * 1024
MAX_LINE_BYTES = 256 * 1024
COUNTERS = {'throttledSeconds': ('cpuStat', 'throttled_usec', 1_000_000),
            'throttledPeriods': ('cpuStat', 'nr_throttled', 1),
            'oomEvents': ('memoryEvents', 'oom', 1),
            'oomKillEvents': ('memoryEvents', 'oom_kill', 1)}


class AnalysisError(Exception):
    pass


def require(condition):
    if not condition:
        raise AnalysisError()


def number(value):
    return type(value) in (int, float) and 0 <= value <= 1e12 and math.isfinite(value)


def counter(value):
    return type(value) is int and 0 <= value <= 2**64 - 1


def validate_windows(value):
    require(isinstance(value, dict) and set(value) == {'version', 'windows'} and
            type(value['version']) is int and value['version'] == 1)
    require(isinstance(value['windows'], list) and 1 <= len(value['windows']) <= 32)
    names = set()
    for window in value['windows']:
        require(isinstance(window, dict) and set(window) == {'name', 'startMonotonicSeconds', 'endMonotonicSeconds'})
        name, start, end = (window[key] for key in ('name', 'startMonotonicSeconds', 'endMonotonicSeconds'))
        require(isinstance(name, str) and NAME.fullmatch(name) and name not in names)
        require(number(start) and number(end) and 0 < end - start <= 7200)
        names.add(name)
    return value['windows']


def empty_component(name):
    return {'name': name, 'samples': 0, 'errorSamples': 0, 'counterResets': 0,
            'clockGaps': 0, 'cpuIntervals': 0, 'cpuSeconds': None,
            'cpuCoverageSeconds': 0, 'cpuCoverageFraction': 0, 'meanCpuCores': None,
            'sampledChargedPeakBytes': None, 'counterCoverageSeconds': {key: 0 for key in COUNTERS},
            **{key: None for key in COUNTERS}}


def sample_values(sample):
    require(isinstance(sample.get('id'), str) and IDENTITY.fullmatch(sample['id']))
    require(counter(sample.get('cpuTotalNs')) and counter(sample.get('memoryCurrentBytes')))
    optional = {}
    for field, (group, key, _) in COUNTERS.items():
        if group in sample:
            require(isinstance(sample[group], dict))
            if key in sample[group]:
                require(counter(sample[group][key]))
                optional[field] = sample[group][key]
    return optional


def analyze(rows, config, components):
    windows = validate_windows(config)
    require(isinstance(components, list) and 1 <= len(components) <= 16 and
            all(isinstance(name, str) and NAME.fullmatch(name) for name in components) and
            len(set(components)) == len(components))
    output = [{**window, 'durationSeconds': window['endMonotonicSeconds'] - window['startMonotonicSeconds'],
               'components': [empty_component(name) for name in components]} for window in windows]
    previous = {}
    for index, row in enumerate(rows):
        require(index < 100_000 and isinstance(row, dict) and isinstance(row.get('samples'), list) and len(row['samples']) <= 16)
        seen = set()
        for sample in row['samples']:
            require(isinstance(sample, dict) and isinstance(sample.get('name'), str) and
                    NAME.fullmatch(sample['name']) and sample['name'] not in seen)
            name = sample['name']; seen.add(name)
            if name not in components:
                continue
            now = sample.get('atMonotonicSeconds'); require(number(now))
            active = [window['components'][components.index(name)] for window in output
                      if window['startMonotonicSeconds'] <= now <= window['endMonotonicSeconds']]
            if 'error' in sample:
                for item in active: item['errorSamples'] += 1
                continue
            optional = sample_values(sample)
            for item in active:
                item['samples'] += 1
                item['sampledChargedPeakBytes'] = max(item['sampledChargedPeakBytes'] or 0, sample['memoryCurrentBytes'])
            old = previous.get(name)
            if old and now <= old['at']:
                for item in active: item['clockGaps'] += 1
                continue
            reset = old and (sample['id'] != old['id'] or sample['cpuTotalNs'] < old['cpu'])
            if reset:
                for item in active: item['counterResets'] += 1
            elif old:
                for window in output:
                    # Crossing intervals are excluded, never prorated. These
                    # clocks come from the collector, not wall-clock phases.
                    if window['startMonotonicSeconds'] <= old['at'] < now <= window['endMonotonicSeconds']:
                        item = window['components'][components.index(name)]
                        item['cpuIntervals'] += 1
                        item['cpuSeconds'] = (item['cpuSeconds'] or 0) + (sample['cpuTotalNs'] - old['cpu']) / 1e9
                        item['cpuCoverageSeconds'] += now - old['at']
                        for field, (_, _, divisor) in COUNTERS.items():
                            if field in optional and field in old['optional'] and optional[field] >= old['optional'][field]:
                                item[field] = (item[field] or 0) + (optional[field] - old['optional'][field]) / divisor
                                item['counterCoverageSeconds'][field] += now - old['at']
            previous[name] = {'at': now, 'id': sample['id'], 'cpu': sample['cpuTotalNs'], 'optional': optional}
    for window in output:
        for item in window['components']:
            item['cpuCoverageFraction'] = item['cpuCoverageSeconds'] / window['durationSeconds']
            if item['cpuCoverageSeconds']:
                item['meanCpuCores'] = item['cpuSeconds'] / item['cpuCoverageSeconds']
                require(math.isfinite(item['meanCpuCores']))
    return {'version': 1, 'measurement': 'cgroup-counter-windows', 'windows': output,
            'limits': ['sampled_memory_peak_is_lower_bound', 'no_component_totals',
                       'cpu_only_within_counter_coverage', 'no_latency_or_capacity_inference']}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def decode(raw):
    try:
        return json.loads(raw, object_pairs_hook=unique_object,
                          parse_constant=lambda _: require(False))
    except (ValueError, UnicodeError, RecursionError):
        raise AnalysisError() from None


def open_input(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_size <= limit)
        return os.fdopen(fd, 'rb')
    except BaseException:
        os.close(fd)
        raise


def capture_rows(source, digest):
    size = 0
    while raw := source.readline(MAX_LINE_BYTES + 1):
        size += len(raw)
        require(size <= MAX_CAPTURE_BYTES and len(raw) <= MAX_LINE_BYTES)
        digest.update(raw)
        yield decode(raw)


def main(args=None):
    parser = Parser(description=__doc__)
    parser.add_argument('--samples', required=True)
    parser.add_argument('--windows', required=True)
    parser.add_argument('--component', action='append', required=True)
    parser.add_argument('--output')
    options = parser.parse_args(args)
    try:
        with open_input(options.windows, 65_536) as source:
            raw_windows = source.read(65_537); require(len(raw_windows) <= 65_536)
        digest = hashlib.sha256()
        with open_input(options.samples, MAX_CAPTURE_BYTES) as source:
            report = analyze(capture_rows(source, digest), decode(raw_windows), options.component)
        report['sourceSha256'] = digest.hexdigest()
        report['windowsSha256'] = hashlib.sha256(raw_windows).hexdigest()
        with open_output(options.output) if options.output else nullcontext(sys.stdout) as target:
            print(json.dumps(report, allow_nan=False), file=target)
        return 0 if any(item['samples'] for window in report['windows'] for item in window['components']) else 1
    except (AnalysisError, OSError):
        print(json.dumps({'error': {'code': 'analysis_refused'}}), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
