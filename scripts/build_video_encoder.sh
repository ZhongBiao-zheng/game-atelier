#!/usr/bin/env bash
# Native arm64 macOS or x64 Windows (MSYS2 MINGW64). No installed codec libraries.
set -euo pipefail
root="${1:?usage: build_video_encoder.sh WORK_DIRECTORY}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$root"
cd "$root"
root="$PWD"
version=8.1.3
archive="ffmpeg-$version.tar.xz"
url="https://ffmpeg.org/releases/$archive"
digest=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
if [[ ! -f "$archive" ]]; then
    curl --fail --location --retry 3 -o "$archive.part" "$url"
    mv "$archive.part" "$archive"
fi
if command -v sha256sum >/dev/null; then hash=(sha256sum); else hash=(shasum -a 256); fi
printf '%s  %s\n' "$digest" "$archive" | "${hash[@]}" -c -
printf '%s  %s\n' "$digest" "$url" > source-sha256.txt
for spec in \
    "$url.asc 5f2880c7fea01f8694d30cb9d06362f77241ee67ce5926b157a226b18f08a538" \
    "https://ffmpeg.org/ffmpeg-devel.asc 397b3becedcd5a98769967ff1ff8501ddc89f8368b8f766e4701377d7dbaabe5"; do
    location=${spec% *}
    name=${location##*/}
    if [[ ! -f "$name" ]]; then curl --fail --location --retry 3 -o "$name" "$location"; fi
    printf '%s  %s\n' "${spec##* }" "$name" | "${hash[@]}" -c -
done
keyring=$(mktemp -d)
trap 'rm -rf "$keyring"' EXIT
gpg --batch --homedir "$keyring" --import ffmpeg-devel.asc
gpg --batch --homedir "$keyring" --verify "$archive.asc" "$archive"
tar -xf "$archive"
case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)
        platform=(--enable-videotoolbox --extra-cflags=-mmacosx-version-min=13.0
                  --extra-ldflags=-mmacosx-version-min=13.0)
        encoder=h264_videotoolbox; suffix= ;;
    MINGW*-x86_64|MSYS*-x86_64)
        platform=(--enable-mediafoundation --enable-d3d11va --enable-x86asm --extra-ldflags=-static)
        encoder=h264_mf; suffix=.exe ;;
    *) echo "Expected native arm64 Darwin or x86_64 MinGW" >&2; exit 1 ;;
esac
mkdir -p build bin
configure="../ffmpeg-$version/configure"
build_shell=/bin/sh
if [[ -n "$suffix" ]]; then
    # Native Win32 GNU make cannot open MSYS /d/... paths in an out-of-tree Makefile.
    cd "ffmpeg-$version"
    configure=./configure
    build_shell=sh.exe
else
    cd build
fi
"$configure" --disable-everything --disable-autodetect \
    --disable-gpl --disable-nonfree --disable-network --disable-shared --enable-static \
    --disable-debug --disable-doc --disable-ffplay --enable-ffmpeg --enable-ffprobe \
    --disable-zlib --enable-protocol=file,pipe --enable-indev=lavfi \
    --enable-demuxer=mov,matroska,gif --enable-muxer=mp4,gif,image2,pcm_s16le,null \
    --enable-parser=h264,hevc,aac,vp9,opus \
    --enable-decoder=h264,hevc,aac,vp8,vp9,opus,gif,rawvideo,wrapped_avframe,pcm_s16le \
    --enable-encoder="$encoder",aac,gif,pcm_s16le,wrapped_avframe \
    --enable-filter=scale,pad,setsar,fps,format,trim,atrim,setpts,asetpts,concat,reverse,areverse,palettegen,paletteuse,split,aresample,aformat,transpose,hflip,vflip,testsrc2,drawbox,aevalsrc,anullsrc,select \
    "${platform[@]}"
builder=$(command -v make || command -v gmake || command -v mingw32-make)
"$builder" SHELL="$build_shell" -j"${ENCODER_BUILD_JOBS:-4}" "ffmpeg$suffix" "ffprobe$suffix"
cp "ffmpeg$suffix" "ffprobe$suffix" "$root/bin/"
if [[ -n "$suffix" ]]; then grep -qx '#define HAVE_X86ASM 1' config.h; fi
cp "$root/ffmpeg-$version/COPYING.LGPLv2.1" "$root/ffmpeg-$version/LICENSE.md" "$root/bin/"
cp "$root/$archive" "$root/bin/"
cp "$root/$archive.asc" "$root/source-sha256.txt" "$script_dir/build_video_encoder.sh" "$root/bin/"
cp "$script_dir/video-encoder-NOTICES.txt" "$root/bin/"
"$root/bin/ffmpeg$suffix" -version > "$root/bin/configuration.txt"
"$root/bin/ffmpeg$suffix" -L > "$root/bin/license.txt" 2>&1
cd "$root/bin"
"${hash[@]}" * > SHA256SUMS.tmp
mv SHA256SUMS.tmp SHA256SUMS
