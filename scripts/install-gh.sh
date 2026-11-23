#!/bin/bash
# Installs the gh this repo pins (ADR 0402 決定1): the official release tarball for this machine's arch, checked
# against the sha256 in gh-cli-version before it is unpacked, placed at one path that does not change with the version.
# The Lima provision runs it on every boot, so a gh already at the pinned version is left alone.
#
# Usage: install-gh.sh [path to gh-cli-version]  (default: the checkout's own)
# GH_INSTALL_PREFIX (default /usr/local) and GH_DOWNLOAD_BASE (default the official releases) exist for tests.
set -euo pipefail

pin="${1:-$(dirname "$0")/../gh-cli-version}"
prefix="${GH_INSTALL_PREFIX:-/usr/local}"
base="${GH_DOWNLOAD_BASE:-https://github.com/cli/cli/releases/download}"

field() { sed -n "s/^$1=//p" "$pin"; }
case "$(uname -m)" in
  aarch64 | arm64) arch=arm64 ;;
  x86_64 | amd64) arch=amd64 ;;
  *) echo "install-gh: no pinned gh for machine $(uname -m)" >&2; exit 1 ;;
esac
version="$(field version)"
sha256="$(field "linux_$arch")"
if [ -z "$version" ] || [ -z "$sha256" ]; then
  echo "install-gh: $pin names no version or no linux_$arch sha256" >&2
  exit 1
fi

if [ "$("$prefix/bin/gh" --version 2> /dev/null | sed -n '1s/^gh version \([^ ]*\).*/\1/p')" = "$version" ]; then
  exit 0
fi

tarball="gh_${version}_linux_${arch}.tar.gz"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/$tarball" "$base/v$version/$tarball"
if ! echo "$sha256  $work/$tarball" | sha256sum -c - > /dev/null 2>&1; then
  echo "install-gh: $tarball does not match the sha256 in $pin" >&2
  exit 1
fi
tar -xzf "$work/$tarball" -C "$work" --strip-components=1
mkdir -p "$prefix/bin"
install -m 755 "$work/bin/gh" "$prefix/bin/gh"
