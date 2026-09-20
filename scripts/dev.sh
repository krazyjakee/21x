#!/bin/bash
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." || exit 1

npm run build && ./node_modules/electron/dist/electron --no-sandbox .
