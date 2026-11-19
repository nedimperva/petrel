#!/usr/bin/env bash
# Points the PKGBUILD at a release and writes .SRCINFO, so the AUR package follows it:
#   ./update.sh 0.4.0
# then, in a clone of ssh://aur@aur.archlinux.org/petrel-bin.git: copy PKGBUILD and .SRCINFO in, commit, push.
# Run it after the GitHub release is published (it downloads the .deb to take its checksum).
set -euo pipefail
cd "$(dirname "$0")"
ver="${1:?usage: ./update.sh VERSION (like 0.4.0)}"
url="https://github.com/nedimperva/petrel"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/petrel.deb" "$url/releases/download/v$ver/Petrel_${ver}_amd64.deb"
curl -fsSL -o "$tmp/LICENSE" "https://raw.githubusercontent.com/nedimperva/petrel/v$ver/LICENSE"
deb_sum="$(sha256sum "$tmp/petrel.deb" | cut -d' ' -f1)"
lic_sum="$(sha256sum "$tmp/LICENSE" | cut -d' ' -f1)"
sed -i -e "s/^pkgver=.*/pkgver=$ver/" -e "s/^pkgrel=.*/pkgrel=1/" PKGBUILD
python3 - "$deb_sum" "$lic_sum" <<'PY'
import re, sys
p = open("PKGBUILD").read()
p = re.sub(r"sha256sums=\([^)]*\)", f"sha256sums=('{sys.argv[1]}'\n            '{sys.argv[2]}')", p)
open("PKGBUILD", "w").write(p)
PY
# .SRCINFO as makepkg --printsrcinfo writes it, without needing Arch to make it.
cat > .SRCINFO <<SRC
pkgbase = petrel-bin
	pkgdesc = Quick capture and notes, as Markdown files in one folder
	pkgver = $ver
	pkgrel = 1
	url = $url
	arch = x86_64
	license = MIT
	depends = webkit2gtk-4.1
	depends = gtk3
	depends = libayatana-appindicator
	depends = librsvg
	depends = libsecret
	depends = hicolor-icon-theme
	optdepends = gnome-keyring: a keyring for the Claude key and the Google sign-in
	optdepends = wl-clipboard: petrel copy on Wayland
	optdepends = xclip: petrel copy on X11
	provides = petrel
	conflicts = petrel
	source = Petrel_${ver}_amd64.deb::$url/releases/download/v$ver/Petrel_${ver}_amd64.deb
	source = LICENSE::https://raw.githubusercontent.com/nedimperva/petrel/v$ver/LICENSE
	sha256sums = $deb_sum
	sha256sums = $lic_sum

pkgname = petrel-bin
SRC
echo "PKGBUILD and .SRCINFO now point at v$ver."
