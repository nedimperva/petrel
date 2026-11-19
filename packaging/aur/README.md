# Petrel on the AUR (`petrel-bin`)

`PKGBUILD` installs Petrel from the `.deb` on its GitHub release, so Omarchy and Arch install and update it with
`yay -S petrel-bin` like anything else. The in-app updater is for the AppImage and Windows; a pacman install
updates through the AUR.

After a release is published:

1. `./update.sh 0.4.0` sets the version and checksums and writes `.SRCINFO`.
2. First time only: `git clone ssh://aur@aur.archlinux.org/petrel-bin.git` (an AUR account with your SSH key).
3. Copy `PKGBUILD` and `.SRCINFO` into that clone, `makepkg -si` once to try it, then commit and push.

The Hyprland lines for the capture and picker keys are in the main README.
