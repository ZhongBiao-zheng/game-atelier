"""Own a suspended native encoder and its descendants as a Windows Job Object."""
import ctypes as c
from ctypes import wintypes as w

kernel = c.WinDLL("kernel32", use_last_error=True)
SIZE_T = c.c_size_t


class BasicLimits(c.Structure):
    _fields_ = [("process_time", c.c_int64), ("job_time", c.c_int64), ("flags", w.DWORD),
                ("min_working_set", SIZE_T), ("max_working_set", SIZE_T), ("active_limit", w.DWORD),
                ("affinity", SIZE_T), ("priority", w.DWORD), ("scheduling", w.DWORD)]


class ExtendedLimits(c.Structure):
    _fields_ = [("basic", BasicLimits), ("io_counters", c.c_uint64 * 6),
                ("process_memory", SIZE_T), ("job_memory", SIZE_T), ("peak_process_memory", SIZE_T),
                ("peak_job_memory", SIZE_T)]


class ThreadEntry(c.Structure):
    _fields_ = [("size", w.DWORD), ("usage", w.DWORD), ("tid", w.DWORD), ("pid", w.DWORD),
                ("priority", w.LONG), ("delta", w.LONG), ("flags", w.DWORD)]


def api(name, result, *params):
    fn = getattr(kernel, name)
    fn.argtypes, fn.restype = params, result
    return fn


create_job = api("CreateJobObjectW", w.HANDLE, w.LPVOID, w.LPCWSTR)
set_limits = api("SetInformationJobObject", w.BOOL, w.HANDLE, c.c_int, w.LPVOID, w.DWORD)
assign = api("AssignProcessToJobObject", w.BOOL, w.HANDLE, w.HANDLE)
close_handle = api("CloseHandle", w.BOOL, w.HANDLE)
open_process = api("OpenProcess", w.HANDLE, w.DWORD, w.BOOL, w.DWORD)
open_thread = api("OpenThread", w.HANDLE, w.DWORD, w.BOOL, w.DWORD)
snapshot = api("CreateToolhelp32Snapshot", w.HANDLE, w.DWORD, w.DWORD)
thread_first = api("Thread32First", w.BOOL, w.HANDLE, c.POINTER(ThreadEntry))
thread_next = api("Thread32Next", w.BOOL, w.HANDLE, c.POINTER(ThreadEntry))
resume = api("ResumeThread", w.DWORD, w.HANDLE)


def _resume_primary(pid):
    # asyncio closes the primary thread handle. The suspended process still has exactly one thread.
    threads = snapshot(0x00000004, 0)  # TH32CS_SNAPTHREAD
    if threads == w.HANDLE(-1).value:
        raise c.WinError(c.get_last_error())
    try:
        entry = ThreadEntry(size=c.sizeof(ThreadEntry))
        found = thread_first(threads, c.byref(entry))
        while found:
            if entry.pid == pid:
                thread = open_thread(0x0002, False, entry.tid)  # THREAD_SUSPEND_RESUME
                if not thread:
                    raise c.WinError(c.get_last_error())
                try:
                    if resume(thread) == 0xFFFFFFFF:
                        raise c.WinError(c.get_last_error())
                    return
                finally:
                    close_handle(thread)
            found = thread_next(threads, c.byref(entry))
        raise OSError("Suspended video process primary thread was not found")
    finally:
        close_handle(threads)


def attach(pid):
    job = create_job(None, None)
    if not job:
        raise c.WinError(c.get_last_error())
    try:
        limits = ExtendedLimits()
        limits.basic.flags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not set_limits(job, 9, c.byref(limits), c.sizeof(limits)):
            raise c.WinError(c.get_last_error())
        process = open_process(0x0101, False, pid)  # PROCESS_SET_QUOTA | PROCESS_TERMINATE
        if not process:
            raise c.WinError(c.get_last_error())
        try:
            if not assign(job, process):
                raise c.WinError(c.get_last_error())
        finally:
            close_handle(process)
        _resume_primary(pid)
        return job
    except BaseException:
        close_handle(job)
        raise
