import copy
import io
import json
import os
import signal
import shutil
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

try:
    import cgroup_collector as cg
except ModuleNotFoundError:
    cg = None


def manifest():
    return {'version': 1, 'prs': ['shop-2', 'shop-3'], 'components': [
        {'name': 'claims', 'path': 'owned.slice', 'role': 'claim'},
        {'name': 'browser', 'path': 'owned.slice/claim.slice/browser.scope', 'role': 'browser', 'pr': 'shop-2'},
        {'name': 'cell', 'path': 'cell.service', 'role': 'cell'},
    ]}


class CgroupCollectorTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(cg, 'the separate cgroup collector is not implemented')
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # macOS exposes /var as a symlink; fixtures use its canonical path so
        # production's no-symlink directory traversal is never weakened.
        self.root = Path(self.tmp.name).resolve()
        self.data = cg.validate_manifest(manifest())
        for comp in self.data['components']:
            self.group(comp['path'])

    def group(self, path, cpu=1_000_000, memory=100, peak=900):
        folder = self.root / path
        folder.mkdir(parents=True, exist_ok=True)
        values = {'cpu.stat': f'usage_usec {cpu}\nuser_usec 500000\nsystem_usec 500000\nnr_throttled 2\nthrottled_usec 300\nSECRET 42\n',
                  'memory.current': str(memory), 'memory.peak': str(peak),
                  'memory.stat': 'anon 60\nfile 40\ninactive_file 20\nSECRET 123\n',
                  'memory.events': 'oom 0\noom_kill 0\nhigh 2\n', 'pids.current': '3',
                  'cpu.pressure': 'some avg10=0.25 avg60=0.00 avg300=0.00 total=500\n',
                  'memory.max': '1024', 'memory.swap.max': '0', 'cpu.max': '50000 100000'}
        for name, value in values.items():
            (folder / name).write_text(value)
        return folder

    def tree(self):
        tree = cg.CgroupTree(str(self.root), mount_check=lambda _fd: None)
        self.addCleanup(tree.close)
        return tree

    def test_manifest_refuses_more_than_two_prs_and_more_than_sixteen_components(self):
        for changed in [{**manifest(), 'prs': ['a', 'b', 'c']},
                        {**manifest(), 'components': manifest()['components'] * 6}]:
            with self.assertRaises(cg.SampleError): cg.validate_manifest(changed)

    def test_manifest_is_closed_and_requires_unique_safe_targets(self):
        cases = []
        for path in ['../secret', '/sys/fs/cgroup/root', 'a/../b', 'a//b', '.', 'a/./b']:
            item = manifest(); item['components'][0]['path'] = path; cases.append(item)
        item = manifest(); item['components'][0]['pr'] = 'not-one-of-the-two'; cases.append(item)
        item = manifest(); item['components'][0]['token'] = 'SECRET'; cases.append(item)
        item = manifest(); item['components'][1]['path'] = 'owned.slice'; cases.append(item)
        item = manifest(); item['components'][1]['name'] = 'claims'; cases.append(item)
        item = manifest(); item['extra'] = 'SECRET'; cases.append(item)
        for value in cases:
            with self.subTest(value=value), self.assertRaises(cg.SampleError): cg.validate_manifest(value)

    def test_fixture_requires_explicit_injection_and_cli_has_no_bypass(self):
        with self.assertRaises(cg.SampleError): cg.CgroupTree(str(self.root))
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            cg.parse_args(['--root', str(self.root), '--manifest', 'fixture.json', '--fixture'])

    def test_only_allowlisted_numeric_fields_are_exported_without_reading_other_files(self):
        group = self.root / 'owned.slice'
        (group / 'secret').write_text('DO-NOT-READ')
        sample = self.tree().sample(self.data['components'][0])
        self.assertEqual(sample['cpuTotalNs'], 1_000_000_000)
        self.assertEqual(sample['memoryCurrentBytes'], 100)
        self.assertEqual(sample['memoryPeakLifetimeBytes'], 900)
        self.assertEqual(sample['memoryStat'], {'anon': 60, 'file': 40, 'inactive_file': 20})
        self.assertEqual(sample['cpuStat']['nr_throttled'], 2)
        self.assertEqual(sample['pressure']['cpu']['some']['totalUsec'], 500)
        self.assertEqual(sample['memorySwapMaxBytes'], 0)
        self.assertNotIn('SECRET', json.dumps(sample))
        self.assertNotIn('DO-NOT-READ', json.dumps(sample))
        self.assertEqual(set(sample['identity']), {'device', 'inode', 'ctimeNs'})

    def test_optional_absent_files_remain_absent_not_zero(self):
        (self.root / 'owned.slice/pids.current').unlink()
        sample = self.tree().sample(self.data['components'][0])
        self.assertNotIn('pidsCurrent', sample)
        self.assertNotIn('memorySwapCurrentBytes', sample)

    def test_missing_required_counter_is_a_gap_not_a_zero(self):
        (self.root / 'owned.slice/cpu.stat').write_text('nr_throttled 2\n')
        row = cg.snapshot(self.tree(), self.data, cg.Tracker(), clock=lambda: 1)
        self.assertEqual(row['samples'][0]['error']['code'], 'invalid_counter')
        self.assertFalse(row['accounting']['complete'])
        self.assertNotIn('memoryCurrentBytes', row['accounting'])
        self.assertNotIn('cpuTotalNs', row['samples'][0])

    def test_cpu_deltas_preserve_baseline_over_gaps_and_do_not_use_cumulative_as_rate(self):
        tracker = cg.Tracker()
        first = {'name':'cell','id':'1:2:3','cpuTotalNs':1_000_000_000,'memoryCurrentBytes':10}
        tracker.annotate(first, 1)
        self.assertNotIn('cpuCoresInterval', first)
        tracker.annotate({'name':'cell','error':{'code':'unavailable'}}, 2)
        next_sample = {**first, 'cpuTotalNs':5_000_000_000, 'memoryCurrentBytes':5}
        tracker.annotate(next_sample, 5)
        self.assertEqual(next_sample['cpuDeltaNs'], 4_000_000_000)
        self.assertEqual(next_sample['cpuCoresInterval'], 1)
        self.assertEqual(next_sample['sampledWindowPeakBytes'], 10)

    def test_identity_change_or_lower_counter_starts_new_cpu_epoch_without_filling_zero(self):
        for identity, total in [('1:2:4', 5_000_000_000), ('1:2:3', 1)]:
            tracker = cg.Tracker(); tracker.annotate({'name':'cell','id':'1:2:3','cpuTotalNs':2_000_000_000,'memoryCurrentBytes':10}, 1)
            sample = {'name':'cell','id':identity,'cpuTotalNs':total,'memoryCurrentBytes':20}
            tracker.annotate(sample, 2)
            self.assertTrue(sample['cpuCounterReset'])
            self.assertNotIn('cpuCoresInterval', sample)
            self.assertNotIn('cpuDeltaNs', sample)

    def test_kernel_lifetime_peak_is_never_called_a_new_window_peak_or_summed(self):
        row = cg.snapshot(self.tree(), self.data, cg.Tracker(), clock=lambda: 1)
        self.assertEqual(row['samples'][0]['memoryPeakLifetimeBytes'], 900)
        self.assertEqual(row['samples'][0]['sampledWindowPeakBytes'], 100)
        self.assertNotIn('memoryPeakLifetimeBytes', row['accounting'])

    def test_parent_and_child_are_not_double_counted_and_path_prefix_siblings_remain_independent(self):
        item = manifest(); item['components'].append({'name':'sibling','path':'owned.slice-other','role':'other'})
        self.group('owned.slice-other', memory=25)
        row = cg.snapshot(self.tree(), cg.validate_manifest(item), cg.Tracker(), clock=lambda: 1)
        self.assertEqual(row['accounting']['includedInTotal'], ['claims','cell','sibling'])
        self.assertEqual(row['accounting']['breakdownOnly'], ['browser'])
        self.assertEqual(row['accounting']['memoryCurrentBytes'], 225)

    def test_recreated_directory_has_new_identity(self):
        tree = self.tree(); old = tree.sample(self.data['components'][2])
        target = self.root/'cell.service'; target.rename(self.root/'old-cell.service')
        self.group('cell.service')
        new = tree.sample(self.data['components'][2])
        self.assertNotEqual(new['id'], old['id'])

    def test_symlink_in_component_or_counter_never_crosses_boundary(self):
        for counter in [False, True]:
            with self.subTest(counter=counter):
                root = self.root/f'link{counter}'
                if counter:
                    self.group(root.name); (root/'memory.current').unlink(); (root/'memory.current').symlink_to('/etc/passwd')
                else: root.symlink_to(self.root/'cell.service', target_is_directory=True)
                value = {'name':'link','path':root.name,'role':'other'}
                row = cg.snapshot(self.tree(), {'components':[value]}, cg.Tracker(), clock=lambda:1)
                self.assertIn('error', row['samples'][0]); self.assertNotIn('root:', json.dumps(row))

    def test_replacing_directory_during_read_is_rejected(self):
        tree = self.tree(); original = tree.read_counter; replaced=[]
        def read_counter(fd, name):
            value = original(fd, name)
            if not replaced:
                replaced.append(True); (self.root/'cell.service').rename(self.root/'old')
                self.group('cell.service', cpu=99)
            return value
        with patch.object(tree, 'read_counter', side_effect=read_counter):
            with self.assertRaises(cg.SampleError) as caught: tree.sample(self.data['components'][2])
        self.assertEqual(caught.exception.code, 'identity_changed')

    def test_oversized_or_invalid_counter_produces_closed_error(self):
        for raw in ['-1','nan','SECRET','9'*70000]:
            (self.root/'cell.service/memory.current').write_text(raw)
            row = cg.snapshot(self.tree(), self.data, cg.Tracker(), clock=lambda:1)
            self.assertIn('error', row['samples'][2]); self.assertNotIn('SECRET', json.dumps(row))

    def test_timeout_is_closed_and_other_targets_continue(self):
        tree=self.tree(); original=tree.sample
        def sample(comp):
            if comp['name']=='claims': raise TimeoutError('SECRET path')
            return original(comp)
        with patch.object(tree,'sample',side_effect=sample):
            row=cg.snapshot(tree,self.data,cg.Tracker(),clock=lambda:1)
        self.assertEqual(row['samples'][0]['error']['code'],'timeout')
        self.assertNotIn('SECRET',json.dumps(row))
        self.assertEqual(row['samples'][2]['memoryCurrentBytes'],100)

    def test_main_output_is_exclusive_private_and_no_mount_bypass_argument(self):
        path=self.root/'manifest.json'; path.write_text(json.dumps(manifest()))
        output=self.root/'measure.jsonl'
        with patch.object(cg,'validate_mount',return_value=None):
            self.assertEqual(cg.main(['--root',str(self.root),'--manifest',str(path),'--duration','0','--output',str(output)]),0)
            with redirect_stderr(io.StringIO()):
                self.assertNotEqual(cg.main(['--root',str(self.root),'--manifest',str(path),'--duration','0','--output',str(output)]),0)
        self.assertEqual(output.stat().st_mode & 0o777,0o600)
        self.assertEqual(len(output.read_text().splitlines()),1)

    def test_manifest_file_size_and_duplicate_keys_are_refused(self):
        for content in ['{"version":1,"version":1}', ' '*70000]:
            path=self.root/'bad.json'; path.write_text(content)
            with self.assertRaises(cg.SampleError): cg.load_manifest(str(path))

    def test_timeout_context_restores_previous_alarm_without_real_sleep(self):
        with patch.object(cg.signal,'getsignal',return_value='previous'), patch.object(cg.signal,'signal') as handler, patch.object(cg.signal,'setitimer',return_value=(0,0)) as timer:
            with cg.deadline(2): pass
        self.assertEqual(timer.call_args_list[0].args,(cg.signal.ITIMER_REAL,2))
        self.assertEqual(timer.call_args_list[-1].args,(cg.signal.ITIMER_REAL,0))
        self.assertEqual(handler.call_args_list[-1].args,(cg.signal.SIGALRM,'previous'))

    def test_each_target_also_requires_the_cgroup_filesystem(self):
        root_inode = self.root.stat().st_ino
        def check(fd):
            if os.fstat(fd).st_ino != root_inode: raise cg.SampleError('invalid_mount')
        tree = cg.CgroupTree(str(self.root), mount_check=check)
        self.addCleanup(tree.close)
        row = cg.snapshot(tree, self.data, cg.Tracker(), clock=lambda:1)
        self.assertTrue(all(item.get('error',{}).get('code')=='invalid_mount' for item in row['samples']))

    def test_actual_deadline_interrupts_a_blocked_target_without_losing_other_samples(self):
        tree=self.tree(); original=tree.sample
        def sample(comp):
            if comp['name']=='claims': signal.pause()
            return original(comp)
        with patch.object(tree,'sample',side_effect=sample):
            row=cg.snapshot(tree,self.data,cg.Tracker(),clock=lambda:1,timeout=.01)
        self.assertEqual(row['samples'][0]['error']['code'],'timeout')
        self.assertEqual(row['samples'][2]['memoryCurrentBytes'],100)

    def test_duplicate_pressure_counters_are_not_silently_overwritten(self):
        (self.root/'cell.service/cpu.pressure').write_text('some total=10 total=20\n')
        row=cg.snapshot(self.tree(),self.data,cg.Tracker(),clock=lambda:1)
        self.assertEqual(row['samples'][2].get('error',{}).get('code'),'invalid_counter')

    def test_native_observed_child_churn_preserves_cpu_delta_with_pinned_identity(self):
        # Native Linux proof kept dev32/inode128891 while ctime changed at every
        # child start/stop. The old epoch key included ctime and falsely reset.
        tree=self.tree(); tracker=cg.Tracker(); component=self.data['components'][2]
        first=tree.sample(component); tracker.annotate(first,1)
        (self.root/'cell.service/child.scope').mkdir()
        (self.root/'cell.service/memory.current').write_text('50')
        (self.root/'cell.service/cpu.stat').write_text('usage_usec 2000000\n')
        second=tree.sample(component); tracker.annotate(second,2)
        self.assertEqual(first['identity']['inode'],second['identity']['inode'])
        self.assertNotEqual(first['identity']['ctimeNs'],second['identity']['ctimeNs'])
        self.assertEqual(first['id'],second['id'])
        self.assertNotIn('cpuCounterReset',second)
        self.assertTrue(second['metadataChanged'])
        self.assertEqual(second['cpuDeltaNs'],1_000_000_000)
        self.assertEqual(second['cpuCoresInterval'],1)
        self.assertEqual(second['memoryCurrentBytes'],50)
        self.assertEqual(second['sampledWindowPeakBytes'],100)

    def test_child_creation_during_read_preserves_memory_with_a_metadata_warning(self):
        tree=self.tree(); original=tree.read_counter; changed=[]
        def read_counter(fd,name):
            value=original(fd,name)
            if not changed:
                changed.append(True); (self.root/'cell.service/child.scope').mkdir()
            return value
        with patch.object(tree,'read_counter',side_effect=read_counter):
            sample=tree.sample(self.data['components'][2])
        self.assertTrue(sample['metadataChangedDuringRead'])
        self.assertEqual(sample['memoryCurrentBytes'],100)

    def test_pin_survives_missing_path_and_is_replaced_only_after_successful_new_sample(self):
        tree=self.tree(); comp=self.data['components'][2]; tree.sample(comp)
        old_fd=tree.pins[comp['path']]
        old_inode=os.fstat(old_fd).st_ino
        shutil.rmtree(self.root/comp['path'])
        row=cg.snapshot(tree,self.data,cg.Tracker(),clock=lambda:1)
        self.assertIn('error',row['samples'][2])
        self.assertEqual(os.fstat(old_fd).st_ino,old_inode)
        self.group(comp['path'])
        sample=tree.sample(comp)
        self.assertNotEqual(int(sample['identity']['inode']),old_inode)
        self.assertNotEqual(tree.pins[comp['path']],old_fd)
        with self.assertRaises(OSError): os.fstat(old_fd)

    def test_pin_cache_is_bounded_and_all_descriptors_close_even_after_missing_targets(self):
        tree=self.tree()
        for n in range(16):
            path=f'group{n}.scope'; self.group(path)
            tree.sample({'name':f'g{n}','path':path,'role':'other'})
        self.assertEqual(len(tree.pins),16)
        self.group('extra.scope')
        with self.assertRaises(cg.SampleError) as caught:
            tree.sample({'name':'extra','path':'extra.scope','role':'other'})
        self.assertEqual(caught.exception.code,'target_limit')
        descriptors=list(tree.pins.values())+[tree.fd]
        tree.close();tree.close()
        for fd in descriptors:
            with self.assertRaises(OSError): os.fstat(fd)


if __name__=='__main__': unittest.main()
