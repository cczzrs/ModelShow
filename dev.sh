#!/bin/sh
set -eu
cd "$(dirname "$0")"
if command -v node >/dev/null 2>&1; then
  JK_NODE=$(command -v node)
elif [ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]; then
  JK_NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
else
  echo '请先安装 Node.js 22.12 或更新版本，再安装依赖。' >&2
  exit 1
fi
JK_TASK=${1:-dev}
if [ "$#" -gt 0 ]; then shift; fi
case "$JK_TASK" in
  test) exec "$JK_NODE" scripts/run-tests.mjs "$@" ;;
  build) exec "$JK_NODE" scripts/build.mjs "$@" ;;
  preview) exec "$JK_NODE" node_modules/vite/bin/vite.js preview --host 127.0.0.1 "$@" ;;
  api) PORT="${PORT:-5174}" exec "$JK_NODE" server/model-pool-server.js "$@" ;;
  serve) exec "$JK_NODE" server/model-pool-server.js "$@" ;;
  dev) exec "$JK_NODE" node_modules/vite/bin/vite.js --host 127.0.0.1 "$@" ;;
  *) echo '用法：./dev.sh [dev|api|serve|build|preview] [参数]，或 ./dev.sh test [分组/文件] [--list]' >&2; exit 1 ;;
esac
