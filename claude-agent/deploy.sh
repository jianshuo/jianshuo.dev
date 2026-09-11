#!/usr/bin/env bash
# Build locally, sync to the VPS, reinstall prod deps (if the lockfile changed), restart the service.
# First-time provisioning (node, caddy, user, dirs, units, linger) is in deploy/provision.sh.
#
# 2026-09-11 起 restart 不再需要守卫：写书/修书跑在 claude-agent 用户管理器的瞬态单元里
# （systemd-run --user，见 src/book-launch.ts），与 claude-agent.service 不同 cgroup，
# 发版随时 restart，书照写。此前的 inflight 守卫 / WAIT_FOR_IDLE / FORCE_RESTART 全部删除。
#
# 仍要小心的一处：正在跑的 runner 换腿时会重新 spawn claude CLI（node_modules 里的
# SDK）——npm ci 会先删光 node_modules 再装，那几秒里换腿会失败。所以 lockfile 没变
# 就跳过 npm ci；变了才装（装的时候有书在跑就打印出来，自己掂量）。
set -euo pipefail

VPS="${VPS:-root@66.42.45.128}"
REMOTE="${REMOTE:-/opt/claude-agent}"

cd "$(dirname "$0")"
echo "▸ build"
npm run build

echo "▸ sync → $VPS:$REMOTE"
rsync -az --delete \
  --exclude node_modules --exclude .env --exclude workspace --exclude '*.log' \
  dist public bin package.json package-lock.json deploy \
  "$VPS:$REMOTE/"

echo "▸ sync skills → $VPS:$REMOTE/.claude/skills"
rsync -az --delete skills/ "$VPS:$REMOTE/.claude/skills/"
ssh "$VPS" "chown -R claude-agent:claude-agent $REMOTE/.claude/skills"

# 在跑的书：claude-agent 用户管理器下 book-* / revise-* 单元。
running_books() {
  ssh "$VPS" "systemctl --user -M claude-agent@ list-units --plain --no-legend 'book-*' 'revise-*' 2>/dev/null | awk '{print \$1}'" || true
}

local_lock="$(md5 -q package-lock.json 2>/dev/null || md5sum package-lock.json | cut -d' ' -f1)"
remote_lock="$(ssh "$VPS" "cat $REMOTE/node_modules/.package-lock.md5 2>/dev/null" || true)"
if [ "$local_lock" != "$remote_lock" ]; then
  busy="$(running_books)"
  if [ -n "$busy" ]; then
    echo "▸ lockfile 变了要 npm ci，但有书在跑（换腿时会撞上 node_modules 重装）："
    echo "$busy" | sed 's/^/    /'
    if [ "${FORCE_NPM_CI:-0}" != "1" ]; then
      echo "  跳过 npm ci（代码已同步）。空窗后：FORCE_NPM_CI=1 ./deploy.sh，或 ssh $VPS 'cd $REMOTE && npm ci --omit=dev'"
      echo "▸ restart"
      ssh "$VPS" "systemctl restart claude-agent"
      exit 2
    fi
  fi
  echo "▸ npm ci"
  ssh "$VPS" "cd $REMOTE && npm ci --omit=dev && echo $local_lock > node_modules/.package-lock.md5"
else
  echo "▸ npm ci 跳过（lockfile 未变）"
fi

echo "▸ restart"
ssh "$VPS" "systemctl restart claude-agent && sleep 1 && systemctl --no-pager --lines=6 status claude-agent | head -10"
busy="$(running_books)"
if [ -n "$busy" ]; then
  echo "▸ 在跑的书（不受 restart 影响）："; echo "$busy" | sed 's/^/    /'
fi
echo "✓ deployed"
