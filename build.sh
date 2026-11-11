#!/usr/bin/env bash
# Builds dist/ (only the files the site needs; never .env) and deploys it with wrangler.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist && mkdir dist
cp index.html chat.html video.html app.css sounds.js config.js favicon.svg share.jpg dist/
cp -R assets dist/assets
find dist -name ".DS_Store" -delete
[ "${1:-}" = "--no-deploy" ] || npx wrangler deploy
