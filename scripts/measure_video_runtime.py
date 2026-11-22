"""Compare archives of the same runtime tree, omitting only its native encoder directory."""
import shutil
import sys
import tempfile
from pathlib import Path


from build_desktop import verify_video_payload


def main(folder: Path, archive: Path) -> None:
    bundle = folder / "GameAtelier"
    version = (bundle / "current").read_text().strip()
    verify_video_payload(archive, version)
    encoder = bundle / "versions" / version / "app" / "video-encoder"
    with tempfile.TemporaryDirectory(dir=folder) as temp:
        saved = Path(temp) / encoder.name
        encoder.rename(saved)
        try:
            baseline = Path(shutil.make_archive(
                str(Path(temp) / "baseline"), "zip" if archive.suffix == ".zip" else "gztar",
                root_dir=folder, base_dir=bundle.name,
            ))
            actual = archive.stat().st_size
            print(f"Runtime bytes: {actual}, without encoder: {baseline.stat().st_size}, "
                  f"increase: {actual - baseline.stat().st_size}")
        finally:
            saved.rename(encoder)


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
