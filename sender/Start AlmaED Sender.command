#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org, then open this file again."
  open https://nodejs.org
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi
if [ ! -d node_modules/@supabase/supabase-js ]; then
  echo "Installing the one package the sender needs. This happens only once..."
  npm install --omit=dev --no-audit --no-fund
fi
node src/index.js
echo
read -n 1 -s -r -p "The sender has stopped. Your dashboard will show it as offline. Press any key to close."
