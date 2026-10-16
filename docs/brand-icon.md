# Crawshrimp icon

`icon.png` is the existing 256 × 256 PNG representation (`ic08`) extracted
without pixel changes from Crawshrimp Harness's `app/assets/icon.icns`.
It is the same orange shrimp artwork used by the desktop application.

The package exports it as `dsh-crawshrimp-browser/icon` for native DSH plugin
metadata. `npm run sync:icon` embeds that same file in the Web client for its
sidebar title and guide entry. `npm run check` verifies the copies match and
the file stays within DSH's 256 KiB icon limit. No external image URL is needed.
