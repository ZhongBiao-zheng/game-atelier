#!/usr/bin/env bash
# Native arm64 macOS or x64 Windows (MSYS2 MINGW64). No installed codec libraries.
set -euo pipefail
root="${1:?usage: video_encoder_check_build.sh WORK_DIRECTORY}"
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
tar -xf "$archive"
case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)
        platform=(--enable-videotoolbox --extra-cflags=-mmacosx-version-min=13.0
                  --extra-ldflags=-mmacosx-version-min=13.0)
        encoder=h264_videotoolbox; suffix= ;;
    MINGW*-x86_64|MSYS*-x86_64)
        platform=(--enable-mediafoundation --disable-x86asm --extra-ldflags=-static)
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
    --enable-zlib --enable-protocol=file,pipe --enable-indev=lavfi \
    --enable-demuxer=mov,matroska,gif --enable-muxer=mp4,gif,image2,pcm_s16le,null \
    --enable-parser=h264,hevc,aac,vp9,opus,png \
    --enable-decoder=h264,hevc,aac,vp8,vp9,opus,gif,png,rawvideo,wrapped_avframe,pcm_s16le \
    --enable-encoder="$encoder",aac,png,gif,pcm_s16le,wrapped_avframe \
    --enable-filter=scale,pad,setsar,fps,format,trim,atrim,setpts,asetpts,concat,reverse,areverse,palettegen,paletteuse,split,aresample,aformat,transpose,hflip,vflip,testsrc2,drawbox,aevalsrc,anullsrc,select \
    "${platform[@]}"
builder=$(command -v make || command -v gmake || command -v mingw32-make)
"$builder" SHELL="$build_shell" -j"${ENCODER_BUILD_JOBS:-4}" ffmpeg ffprobe
cp "ffmpeg$suffix" "ffprobe$suffix" "$root/bin/"
"$root/bin/ffmpeg$suffix" -version > "$root/version.txt"
"$root/bin/ffmpeg$suffix" -L > "$root/license.txt" 2>&1
