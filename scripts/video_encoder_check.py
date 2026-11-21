"""Offline native encoder test. Requires the project's OpenCV and the measured ffmpeg/ffprobe pair."""
import argparse
import json
import os
from pathlib import Path
import platform
import struct
import subprocess
import sys
import time

import cv2
import numpy as np


def run(argv, binary=False):
    result = subprocess.run(argv, capture_output=True, timeout=120, check=False)
    if result.returncode:
        message = result.stderr.decode("utf-8", "replace")[-4000:]
        raise RuntimeError(f"{Path(argv[0]).name} exited {result.returncode}: {message}")
    return result.stdout if binary else result.stdout.decode("utf-8", "replace")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def moov_first(path):
    """Read top-level ISO BMFF box headers, including extended sizes."""
    with path.open("rb") as media:
        while header := media.read(8):
            size, kind = struct.unpack(">I4s", header)
            header_size = 8
            if size == 1:
                size, = struct.unpack(">Q", media.read(8))
                header_size = 16
            if kind in (b"moov", b"mdat"):
                return kind == b"moov"
            if size < header_size:
                return False
            media.seek(size - header_size, 1)
    return False


def frame_stamp():
    # Seven binary digits in a high-contrast band. Least significant bit on the left.
    filters = ["drawbox=x=0:y=0:w=116:h=20:c=black:t=fill"]
    for bit in range(7):
        filters.append(f"drawbox=x={bit * 16 + 2}:y=2:w=12:h=16:c=white:t=fill:"
                       f"enable='mod(floor(n/{2**bit}),2)'")
    return ",".join(filters)


def read_video(path, stamp=False):
    cap = cv2.VideoCapture(str(path))
    try:
        require(cap.isOpened(), f"OpenCV could not open {path.name}")
        frames = []
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            frames.append(sum(1 << b for b in range(7) if frame[10, 8+16*b].mean() > 128)
                          if stamp else None)
        require(frames, f"OpenCV decoded zero frames from {path.name}")
        return frames
    finally:
        cap.release()


class Check:
    def __init__(self, directory, out):
        suffix = ".exe" if os.name == "nt" else ""
        self.ff = str((directory / ("ffmpeg"+suffix)).resolve())
        self.probe = str((directory / ("ffprobe"+suffix)).resolve())
        self.dir = out / "samples"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.encoder = "h264_mf" if os.name == "nt" else "h264_videotoolbox"
        self.rows = []

    def ffmpeg(self, *args, binary=False):
        return run([self.ff, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", *args],
                   binary=binary)

    def metadata(self, path, *args):
        return json.loads(run([self.probe, "-v", "error", "-of", "json", *args, path]))

    def encode(self, rate="600k"):
        # Use a target bitrate on both platforms. MF accepts NV12 as encoder input.
        mf = self.encoder == "h264_mf"
        return ["-c:v", self.encoder, "-pix_fmt", "nv12" if mf else "yuv420p",
                *(["-rate_control", "cbr"] if mf else ["-allow_sw", "1"]),
                "-b:v", rate, "-c:a", "aac", "-ar", "48000", "-ac", "1",
                "-movflags", "+faststart"]

    def pcm(self, path):
        data = self.ffmpeg("-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "48000",
                           "-f", "s16le", "-", binary=True)
        return np.frombuffer(data, dtype="<i2").astype(float)

    def timeline(self, audio, beeps, seconds):
        expected = np.zeros(len(audio), dtype=bool)
        for start, end in beeps:
            expected[round(start*48000):round(end*48000)] = True
        # Ignore only the transition near the edge of each pulse (AAC window).
        for t in np.arange(.025, seconds-.025, .025):
            mid = round(t*48000)
            segment = expected[mid-960:mid+960]
            if len(segment) != 1920 or not np.all(segment == segment[0]):
                continue
            rms = np.sqrt(np.mean(audio[mid-480:mid+480]**2))
            require((rms > 700) == bool(segment[0]), f"audio marker mismatch at {t:.3f}s")

    def verify(self, path, seconds, fps, audio, dimensions, codes=None, pulses=None):
        meta = self.metadata(path, "-show_format", "-show_streams")
        video, = [s for s in meta["streams"] if s["codec_type"] == "video"]
        tracks = [s for s in meta["streams"] if s["codec_type"] == "audio"]
        gif = path.suffix == ".gif"
        require(len(tracks) == int(audio), f"unexpected audio tracks: {len(tracks)}")
        require((video["width"], video["height"]) == dimensions, "incorrect output dimensions")
        require(video["codec_name"] == ("gif" if gif else "h264"), "unexpected video codec")
        if not gif:
            require(video["pix_fmt"] == "yuv420p" and moov_first(path), "pixel format or MP4 boxes")
        frames = read_video(path, codes is not None)
        require(abs(len(frames)-seconds*fps) <= 1, f"frame count {len(frames)}")
        if codes is not None:
            require(frames == list(codes), f"source frame order mismatch: {frames[:10]}")
        durations = [float(meta["format"]["duration"]), float(video["duration"])]
        if tracks:
            require(tracks[0]["codec_name"] == "aac", "unexpected audio codec")
            durations.append(float(tracks[0]["duration"]))
            self.timeline(self.pcm(path), pulses or [], seconds)
        require(all(abs(d-seconds) <= 1/fps+1e-5 for d in durations), f"durations {durations}")
        return {"frames": len(frames), "durations_s": durations, "audio": audio,
                "codec": video["codec_name"], "pixel_format": video["pix_fmt"],
                "bytes": path.stat().st_size, "bitrate_bps": int(meta["format"]["bit_rate"])}

    def sample(self, name, size, fps, sound, vfr=False):
        output = self.dir / (name+".mp4")
        inputs = ["-f", "lavfi", "-i", f"testsrc2=size={size}:rate={fps}:duration=3"]
        if sound:
            inputs += ["-f", "lavfi", "-i",
                       r"aevalsrc=0.55*sin(2*PI*880*t)*between(t\,0.75\,1.0):s=48000:d=3,aformat=sample_fmts=s16"]
        vf = frame_stamp()
        if vfr:
            vf += ",select='lt(t,1.5)+not(mod(n,2))'"
        self.ffmpeg(*inputs, "-vf", vf, "-fps_mode", "vfr", *self.encode("1800k"), output)
        return output

    def suite(self):
        # A registered encoder name alone does not prove MF/VideoToolbox can instantiate it.
        smoke = self.dir / "smoke.mp4"
        self.ffmpeg("-f", "lavfi", "-i", "testsrc2=s=320x192:r=24:d=0.25",
                    *self.encode(), smoke)
        self.verify(smoke, .25, 24, False, (320, 192))
        wide = self.sample("wide", "320x192", 24, True)
        tall = self.sample("tall", "192x320", 30, True)
        silent = self.sample("silent", "320x192", 24, False)
        vfr = self.sample("vfr", "320x192", 24, True, vfr=True)
        rotated = self.dir / "rotation.mp4"
        self.ffmpeg("-display_rotation", "90", "-i", wide, "-map", "0", "-c", "copy",
                    "-movflags", "+faststart", rotated)
        rot = self.metadata(rotated, "-select_streams", "v:0", "-show_streams")["streams"][0]
        require(any(abs(s.get("rotation", 0)) == 90 for s in rot["side_data_list"]), "rotation tag")
        timestamps = self.metadata(vfr, "-select_streams", "v:0", "-show_packets",
                                   "-show_entries", "packet=pts_time")
        pts = sorted(float(p["pts_time"]) for p in timestamps["packets"])
        require(len(set(round(x*1000) for x in np.diff(pts))) >= 2, "fixture is not VFR")
        self.verify(wide, 3, 24, True, (320, 192), range(72), [(.75, 1)])
        self.verify(tall, 3, 30, True, (192, 320), range(90), [(.75, 1)])
        self.verify(silent, 3, 24, False, (320, 192), range(72))
        require(read_video(vfr) and read_video(rotated), "unreadable fixture")

        def operation(name, inputs, tail, seconds=3, fps=24, audio=True, dims=(320, 192),
                      codes=None, pulses=None, extension=".mp4"):
            row = {"operation": name, "status": "failed"}
            self.rows.append(row)
            output = self.dir / (name + extension)
            started = time.perf_counter()
            try:
                self.ffmpeg(*inputs, *tail, output)
                row["encode_s"] = round(time.perf_counter()-started, 3)
                row.update(self.verify(output, seconds, fps, audio, dims, codes, pulses))
                row["status"] = "passed"
            except (ValueError, RuntimeError, OSError) as error:
                row["error"] = str(error)

        operation("trim", ["-i", wide], ["-ss", "0.5", "-t", "1", *self.encode()],
                  1, codes=range(12, 36), pulses=[(.25, .5)])
        for label, rate in (("small", "240k"), ("standard", "420k"), ("high", "700k")):
            operation("compress_"+label, ["-i", wide], self.encode(rate),
                      codes=range(72), pulses=[(.75, 1)])
        for mute in (False, True):
            sound = ["-an"] if mute else ["-af", "areverse"]
            operation("reverse_mute" if mute else "reverse_audio", ["-i", wide],
                      ["-vf", "reverse", *sound, *self.encode()], audio=not mute,
                      codes=reversed(range(72)), pulses=[(2, 2.25)])
        operation("gif", ["-i", wide], ["-an", "-filter_complex",
                  "fps=10,split[a][b];[a]palettegen[p];[b][p]paletteuse", "-loop", "0"],
                  fps=10, audio=False, extension=".gif")
        operation("normalize_vfr", ["-i", vfr], ["-vf", "fps=24", *self.encode()],
                  pulses=[(.75, 1)])
        operation("apply_rotation", ["-i", rotated], self.encode(), dims=(192, 320),
                  pulses=[(.75, 1)])
        inputs = ["-i", wide, "-i", silent, "-i", tall, "-f", "lavfi", "-i",
                  "anullsrc=r=48000:cl=mono:d=3,aformat=sample_fmts=s16"]
        filters = [f"[{i}:v]fps=24,scale=320:192:force_original_aspect_ratio=decrease:"
                   f"force_divisible_by=2,pad=320:192:(ow-iw)/2:(oh-ih)/2,setsar=1[v{i}]"
                   for i in range(3)]
        filters += [f"[{i}:a]atrim=duration=3,asetpts=PTS-STARTPTS[a{i}]" for i in (0, 3, 2)]
        filters.append("[v0][a0][v1][a3][v2][a2]concat=n=3:v=1:a=1[v][a]")
        operation("concat", inputs, ["-filter_complex", ";".join(filters),
                  "-map", "[v]", "-map", "[a]", *self.encode()], 9,
                  pulses=[(.75, 1), (6.75, 7)])
        png = self.dir / "frame.png"
        row = {"operation": "extract", "status": "failed"}
        self.rows.append(row)
        start = time.perf_counter()
        try:
            self.ffmpeg("-i", wide, "-ss", "1", "-frames:v", "1", "-an", png)
            row["encode_s"] = round(time.perf_counter()-start, 3)
            frame = cv2.imread(str(png))
            require(frame is not None and frame.shape[:2] == (192, 320), "PNG unreadable")
            require(sum(1 << b for b in range(7) if frame[10, 8+16*b].mean() > 128) == 24,
                    "incorrect extracted frame")
            row.update(status="passed", bytes=png.stat().st_size, bitrate_bps=None)
        except (ValueError, RuntimeError, OSError) as error:
            row["error"] = str(error)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bin-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=Path(".scratch/video-encoder-check"))
    args = parser.parse_args()
    check = Check(args.bin_dir, args.out)
    report = {"platform": platform.platform(), "machine": platform.machine(),
              "opencv": cv2.__version__, "encoder": check.encoder, "operations": check.rows}
    try:
        check.suite()
        report["passed"] = all(row["status"] == "passed" for row in check.rows)
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        report.update(passed=False, setup_error=str(error))
    result = json.dumps(report, ensure_ascii=False, indent=2)
    (args.out / "results.json").write_text(result, encoding="utf-8")
    print(result)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
