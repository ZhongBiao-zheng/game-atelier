"""临时诊断（批次 1b，查清后删除）：Windows 上 os.replace 进行中，目标名查不到能持续多久。"""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path

from character_workflow.lib import jobs
from tests.test_unlocked_reads import _job


def test_measure_missing_window(isolated_data_root, monkeypatch):
    job = _job()
    path = jobs._path(job.job_id)
    gaps: list[float] = []
    samples: list[str] = []
    replace_denied = {"n": 0}
    real_replace = Path.replace

    def counting_replace(self, target):
        try:
            return real_replace(self, target)
        except PermissionError:
            replace_denied["n"] += 1
            raise

    monkeypatch.setattr(Path, "replace", counting_replace)
    stop = threading.Event()

    def writer():
        try:
            for index in range(300):
                jobs.update_job_phase(job.job_id, f"queued:{index + 1}")
        finally:
            stop.set()

    def reader():
        while not stop.is_set():
            try:
                path.read_text(encoding="utf-8")
            except FileNotFoundError:
                start = time.perf_counter()
                listing = sorted(item.name for item in path.parent.iterdir())
                while True:
                    try:
                        path.read_text(encoding="utf-8")
                        break
                    except (FileNotFoundError, PermissionError):
                        time.sleep(0.001)
                gaps.append(time.perf_counter() - start)
                if len(samples) < 5:
                    samples.append(f"exists={os.path.exists(path)} dir={listing}")
            except PermissionError:
                pass
            time.sleep(0.001)

    threads = [threading.Thread(target=writer), *(threading.Thread(target=reader) for _ in range(3))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(120)
    gaps.sort()
    print(f"\nMISSING-WINDOW gaps={len(gaps)} max={gaps[-1] if gaps else 0:.4f}s "
          f"p99={gaps[int(len(gaps) * 0.99)] if gaps else 0:.4f}s replace_denied={replace_denied['n']}")
    for sample in samples:
        print("MISSING-SAMPLE", sample)
