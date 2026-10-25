#!/usr/bin/env bash
# 本地 test+build → rsync → （依赖变了才）npm ci → 重启。首次开服先跑 deploy/provision.sh。
# 重启不杀正在跑的任务（unit 里 KillMode=process，runner 是 detached 子进程）。
set -euo pipefail
VPS="${VPS:-root@66.42.45.128}"
REMOTE="${REMOTE:-/opt/engine-router}"

cd "$(dirname "$0")"
echo "▸ test + build"
npm test
npm run build

echo "▸ sync → $VPS:$REMOTE"
rsync -az --delete dist/ "$VPS:$REMOTE/dist/"
rsync -az package.json package-lock.json config.example.json "$VPS:$REMOTE/"
rsync -az --delete deploy/ "$VPS:$REMOTE/deploy/"

echo "▸ deps + restart"
# lockfile 没变就不 npm ci：runner 换账号时会从 node_modules 起 claude CLI，装依赖那几秒会撞上。
ssh "$VPS" "set -e; cd $REMOTE
  chown -R engine-router:engines dist deploy package.json package-lock.json config.example.json
  if ! cmp -s package-lock.json node_modules/.deployed-lock 2>/dev/null; then
    echo '  npm ci'; sudo -u engine-router HOME=$REMOTE npm ci --omit=dev --no-audit --no-fund --silent
    sudo -u engine-router cp package-lock.json node_modules/.deployed-lock
  fi
  systemctl restart engine-router && sleep 1 && systemctl --no-pager status engine-router | head -6"
echo "✓ deployed"
