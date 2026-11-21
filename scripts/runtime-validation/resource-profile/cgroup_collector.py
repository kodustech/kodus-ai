"""Passive, explicitly scoped Linux cgroup v2 counters for at most two PRs."""
import ctypes
import datetime
import errno
import json
import math
import os
import re
import signal
import stat
import sys
import time
from contextlib import contextmanager, nullcontext

from collector import Parser, SampleError, add_cpu_rate, open_output

MAX_FILE_BYTES = 65_536
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z')
PART = re.compile(r'[A-Za-z0-9_.:-]{1,255}\Z')
ROLES = {'claim', 'cell', 'hub', 'worker', 'api', 'webhooks', 'database', 'broker',
         'egress', 'resolver', 'injector', 'registry', 'builder', 'observer', 'browser', 'other'}
CPU = {'usage_usec', 'user_usec', 'system_usec', 'nr_periods', 'nr_throttled', 'throttled_usec'}
MEMORY = {'anon', 'file', 'kernel', 'inactive_file', 'active_file', 'shmem', 'slab'}
EVENTS = {'low', 'high', 'max', 'oom', 'oom_kill', 'oom_group_kill'}
FILES = {'cpu.stat', 'cpu.max', 'memory.current', 'memory.peak', 'memory.stat', 'memory.events',
         'memory.max', 'memory.swap.current', 'memory.swap.max', 'pids.current', 'pids.max',
         'cpu.pressure', 'memory.pressure', 'io.pressure'}
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def fail(code):
    raise SampleError(code)


def validate_manifest(value):
    if not isinstance(value, dict) or set(value) != {'version', 'prs', 'components'} or type(value['version']) is not int or value['version'] != 1:
        fail('invalid_manifest')
    prs, components = value['prs'], value['components']
    if not isinstance(prs, list) or not 1 <= len(prs) <= 2 or any(not isinstance(p, str) or not NAME.fullmatch(p) for p in prs) or len(set(prs)) != len(prs):
        fail('invalid_manifest')
    if not isinstance(components, list) or not 1 <= len(components) <= 16:
        fail('invalid_manifest')
    names, paths = set(), set()
    for comp in components:
        if not isinstance(comp, dict) or not {'name', 'path', 'role'} <= set(comp) or set(comp) - {'name', 'path', 'role', 'pr'}:
            fail('invalid_manifest')
        name, path, role = comp['name'], comp['path'], comp['role']
        if (not isinstance(name, str) or not NAME.fullmatch(name) or name in names or
                not isinstance(path, str) or len(path) > 1024 or not 1 <= len(path.split('/')) <= 16 or
                any(part in {'.', '..'} or not PART.fullmatch(part) for part in path.split('/')) or path in paths or
                not isinstance(role, str) or role not in ROLES or ('pr' in comp and comp['pr'] not in prs)):
            fail('invalid_manifest')
        names.add(name); paths.add(path)
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result: fail('invalid_manifest')
        result[key] = value
    return result


def load_manifest(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): fail('invalid_manifest')
        content = os.read(fd, MAX_FILE_BYTES + 1)
        if len(content) > MAX_FILE_BYTES: fail('invalid_manifest')
        try: value = json.loads(content, object_pairs_hook=unique_object)
        except (ValueError, UnicodeError): fail('invalid_manifest')
        return validate_manifest(value)
    finally:
        os.close(fd)


def validate_mount(fd):
    # Linux fstatfs starts with f_type; the oversized buffer avoids depending on
    # the rest of the architecture-specific statfs struct. No CLI fixture bypass.
    if sys.platform != 'linux': fail('invalid_mount')
    libc = ctypes.CDLL(None, use_errno=True)
    call = libc.fstatfs
    call.argtypes, call.restype = [ctypes.c_int, ctypes.c_void_p], ctypes.c_int
    data = ctypes.create_string_buffer(512)
    if call(fd, data) != 0 or ctypes.c_long.from_buffer(data).value != 0x63677270:
        fail('invalid_mount')


def absolute_directory(path):
    if not os.path.isabs(path) or os.path.normpath(path) != path: fail('path_rejected')
    fd = os.open('/', DIR_FLAGS)
    try:
        for part in path.split('/')[1:]:
            if not part: continue
            next_fd = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd); fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def identity(fd):
    info = os.fstat(fd)
    return {'device': str(info.st_dev), 'inode': str(info.st_ino), 'ctimeNs': str(info.st_ctime_ns)}


def stable_identity(value):
    return value['device'], value['inode']


def integer(raw):
    raw = raw.strip()
    if not re.fullmatch(r'[0-9]{1,20}', raw): fail('invalid_counter')
    value = int(raw)
    if value > 2**64 - 1: fail('invalid_counter')
    return value


def counters(raw, allowed):
    out = {}
    for line in raw.splitlines():
        parts = line.split()
        if parts and parts[0] in allowed:
            if len(parts) != 2 or parts[0] in out: fail('invalid_counter')
            out[parts[0]] = integer(parts[1])
    return out


def pressure(raw):
    out = {}
    for line in raw.splitlines():
        parts = line.split()
        if not parts or parts[0] not in {'some', 'full'}: continue
        if parts[0] in out: fail('invalid_counter')
        values = {}
        for item in parts[1:]:
            key, sep, value = item.partition('=')
            if key not in {'avg10', 'avg60', 'avg300', 'total'}: continue
            if not sep or ('totalUsec' if key == 'total' else key) in values: fail('invalid_counter')
            if key == 'total': values['totalUsec'] = integer(value)
            else:
                try: n = float(value)
                except ValueError: fail('invalid_counter')
                if not math.isfinite(n) or not 0 <= n <= 100: fail('invalid_counter')
                values[key] = n
        out[parts[0]] = values
    return out


class CgroupTree:
    def __init__(self, root, mount_check=None):
        self.root, self.fd = root, absolute_directory(root)
        self.pins = {}
        try:
            self.mount_check = mount_check or validate_mount
            self.mount_check(self.fd)
            self.root_identity = identity(self.fd)
        except BaseException:
            self.close(); raise

    def close(self):
        for fd in self.pins.values(): os.close(fd)
        self.pins.clear()
        if self.fd is not None:
            os.close(self.fd); self.fd = None

    def directory(self, path):
        # Each component is opened relative to pinned descriptors, never through
        # a resolved string that could switch to a symlink before open().
        if not isinstance(path, str) or not path or len(path) > 1024 or len(path.split('/')) > 16 or any(p in {'.','..'} or not PART.fullmatch(p) for p in path.split('/')):
            fail('path_rejected')
        current_root = absolute_directory(self.root)
        try:
            current = identity(current_root)
            if any(current[key] != self.root_identity[key] for key in ('device', 'inode')):
                fail('identity_changed')
        finally: os.close(current_root)
        fd = os.dup(self.fd)
        try:
            for part in path.split('/'):
                next_fd = os.open(part, DIR_FLAGS, dir_fd=fd)
                os.close(fd); fd = next_fd
            self.mount_check(fd)
            return fd
        except BaseException:
            os.close(fd); raise

    def read_counter(self, fd, name):
        if name not in FILES: fail('path_rejected')
        try: counter = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
        except FileNotFoundError: return None
        try:
            if not stat.S_ISREG(os.fstat(counter).st_mode): fail('invalid_counter')
            raw = os.read(counter, MAX_FILE_BYTES + 1)
            if len(raw) > MAX_FILE_BYTES: fail('response_too_large')
            try: return raw.decode('ascii')
            except UnicodeError: fail('invalid_counter')
        finally: os.close(counter)

    def sample(self, component):
        path = component['path']
        if path not in self.pins and len(self.pins) >= 16: fail('target_limit')
        fd = self.directory(component['path'])
        try:
            before = identity(fd)
            values = {name: self.read_counter(fd, name) for name in sorted(FILES)}
            for name in ('cpu.stat', 'memory.current', 'memory.peak'):
                if values[name] is None: fail('counter_missing')
            cpu = counters(values['cpu.stat'], CPU)
            if 'usage_usec' not in cpu: fail('invalid_counter')
            result = {**{k:v for k,v in component.items() if k != 'path'}, 'identity': before,
                      'id': ':'.join(stable_identity(before)), 'cpuTotalNs': cpu['usage_usec'] * 1000,
                      'cpuStat': cpu, 'memoryCurrentBytes': integer(values['memory.current']),
                      'memoryPeakLifetimeBytes': integer(values['memory.peak'])}
            for name, field, allowed in [('memory.stat','memoryStat',MEMORY), ('memory.events','memoryEvents',EVENTS)]:
                if values[name] is not None: result[field] = counters(values[name], allowed)
            for name, field in [('memory.max','memoryMaxBytes'), ('memory.swap.max','memorySwapMaxBytes'), ('memory.swap.current','memorySwapCurrentBytes'), ('pids.current','pidsCurrent'), ('pids.max','pidsMax')]:
                if values[name] is not None:
                    result[field] = 'max' if values[name].strip() == 'max' and name.endswith('.max') else integer(values[name])
            if values['cpu.max'] is not None:
                parts = values['cpu.max'].split()
                if len(parts) != 2: fail('invalid_counter')
                result['cpuMax'] = {'quotaUsec': 'max' if parts[0] == 'max' else integer(parts[0]), 'periodUsec': integer(parts[1])}
            result['pressure'] = {kind: pressure(values[kind+'.pressure']) for kind in ('cpu','memory','io') if values[kind+'.pressure'] is not None}
            current_fd = self.directory(component['path'])
            try:
                after, current = identity(fd), identity(current_fd)
                if stable_identity(after) != stable_identity(before) or stable_identity(current) != stable_identity(before): fail('identity_changed')
                # kernfs changes directory ctime when children start/stop; that
                # metadata change must not erase CPU exactly at browser start.
                if after != before or current != before: result['metadataChangedDuringRead'] = True
                result['identity'] = current
                pinned = self.pins.get(path)
                if pinned is None or stable_identity(identity(pinned)) != stable_identity(before):
                    # The old inode stays pinned through disappearance and new
                    # path validation. Only then may its descriptor be closed.
                    next_pin = os.dup(fd)
                    self.pins[path] = next_pin
                    if pinned is not None: os.close(pinned)
            finally: os.close(current_fd)
            return result
        finally: os.close(fd)


class Tracker:
    def __init__(self):
        self.previous, self.peaks, self.metadata = {}, {}, {}

    def annotate(self, sample, now):
        if 'error' in sample: return
        old = self.previous.get(sample['name'])
        add_cpu_rate(sample, self.previous, now)
        if old and 'cpuCoresInterval' in sample: sample['cpuDeltaNs'] = sample['cpuTotalNs'] - old[1]
        ctime = sample.get('identity', {}).get('ctimeNs')
        if sample.get('metadataChangedDuringRead') or (sample['name'] in self.metadata and self.metadata[sample['name']] != ctime):
            sample['metadataChanged'] = True
        self.metadata[sample['name']] = ctime
        peak = max(self.peaks.get(sample['name'], 0), sample['memoryCurrentBytes'])
        self.peaks[sample['name']] = sample['sampledWindowPeakBytes'] = peak


def timeout_handler(_signum, _frame):
    raise TimeoutError()


@contextmanager
def deadline(seconds):
    handler = signal.getsignal(signal.SIGALRM)
    signal.signal(signal.SIGALRM, timeout_handler)
    started = time.monotonic()
    previous = signal.setitimer(signal.ITIMER_REAL, seconds)
    try: yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, handler)
        if previous[0] > 0:
            signal.setitimer(signal.ITIMER_REAL, max(0.000001, previous[0] - (time.monotonic()-started)), previous[1])


def error_code(error):
    if isinstance(error, SampleError): return error.code
    if isinstance(error, TimeoutError): return 'timeout'
    if isinstance(error, OSError) and error.errno in (errno.ELOOP, errno.ENOTDIR): return 'path_rejected'
    return 'unavailable'


def snapshot(tree, manifest, tracker, clock=time.monotonic, timeout=3):
    rows = []
    for component in manifest['components']:
        try:
            with deadline(timeout): sample = tree.sample(component)
        except Exception as error:
            sample = {**{k:v for k,v in component.items() if k != 'path'}, 'error': {'code': error_code(error)}}
        at = clock(); tracker.annotate(sample, at)
        sample['atMonotonicSeconds'] = at
        rows.append(sample)
    components = manifest['components']
    included = [c['name'] for c in components if not any(c['path'].startswith(other['path'] + '/') for other in components if other is not c)]
    totals = [r for r in rows if r['name'] in included]
    accounting = {'includedInTotal': included, 'breakdownOnly': [c['name'] for c in components if c['name'] not in included],
                  'complete': all('error' not in row for row in totals)}
    if accounting['complete']: accounting['memoryCurrentBytes'] = sum(row['memoryCurrentBytes'] for row in totals)
    return {'samples': rows, 'accounting': accounting}


def parse_args(args=None):
    parser = Parser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--duration', type=float, default=60)
    parser.add_argument('--interval', type=float, default=1)
    parser.add_argument('--timeout', type=float, default=3)
    parser.add_argument('--output')
    options = parser.parse_args(args)
    if (not os.path.isabs(options.root) or not math.isfinite(options.duration) or not 0 <= options.duration <= 7200 or
            not math.isfinite(options.interval) or not .2 <= options.interval <= 300 or
            not math.isfinite(options.timeout) or not .1 <= options.timeout <= 30): parser.error('bounds')
    return options


def main(args=None):
    options = parse_args(args)
    tree = None
    try:
        with deadline(options.timeout):
            manifest = load_manifest(options.manifest)
            tree = CgroupTree(options.root)
        with open_output(options.output) if options.output else nullcontext(sys.stdout) as output:
            tracker, started, measured = Tracker(), time.monotonic(), False
            while True:
                began = time.monotonic()
                row = snapshot(tree, manifest, tracker, timeout=options.timeout)
                measured = measured or any('error' not in sample for sample in row['samples'])
                row.update(at=datetime.datetime.now(datetime.timezone.utc).isoformat(), elapsedSeconds=time.monotonic()-started, prs=manifest['prs'])
                print(json.dumps(row, allow_nan=False), file=output, flush=True)
                remaining = options.duration - (time.monotonic()-started)
                if remaining <= 0: break
                time.sleep(min(remaining, max(0, options.interval-(time.monotonic()-began))))
                if time.monotonic()-started >= options.duration: break
        return 0 if measured else 1
    except KeyboardInterrupt: return 130
    except Exception as error:
        print(json.dumps({'error': {'code': error_code(error)}}), file=sys.stderr)
        return 1
    finally:
        if tree: tree.close()


if __name__ == '__main__': raise SystemExit(main())
