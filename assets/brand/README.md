# SyncShot identity

The shared mark is the existing website's Lucide Crop symbol, rendered with a solid `#ffffff` stroke. Its paths and license are preserved in this directory. Launcher tiles use a flat `#141416` charcoal background; the website header uses the transparent white mark.

Run `node scripts/generate-brand-icons.mjs` on macOS after installing the website's dependencies. The script uses the Sharp dependency bundled with Next.js and macOS `iconutil`. It generates the Mac ICNS/PNG and menu-bar template, Android launcher densities and vector foregrounds, web ICO/SVG/Apple touch icons, and the desktop webview favicon. It reads both paths from `syncshot.svg`.

Android's adaptive foreground occupies the central 54dp of its 108dp viewport to fit launcher masks. The header uses the unpadded vector; legacy launcher variants have charcoal tiles. Android themed icons and the macOS menu-bar template allow the OS to choose contrasting colors in their system-controlled contexts.

App updates retain existing signing configuration. A changed ad-hoc Mac build may need renewed Screen Recording consent. Never automatically reset privacy permissions as part of an icon update. Android upgrades must match the installed app's certificate; never uninstall an existing app to bypass a signing mismatch.
