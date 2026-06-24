# Slicer configuration directory

This directory will eventually hold full OrcaSlicer `.ini` and
`filament.json` profiles ported from your local Bambu Studio / OrcaSlicer
config (`~/AppData/Roaming/OrcaSlicer/` on Windows,
`~/.config/OrcaSlicer/` on Linux).

For v1, the backend generates minimal in-memory configs in
`src/slicer.js` so it ships without depending on file uploads. Replace
`PRINTER_PROFILES` and `FILAMENT_PROFILES` with reads from `.json` files
in this directory when you're ready to use your real Bambu-tuned profiles.
</content>
</invoke>
