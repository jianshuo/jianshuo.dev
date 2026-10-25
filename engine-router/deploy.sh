#!/usr/bin/env bash
# engine-router 部署。首次开服先跑 deploy/provision.sh。
#
#   ./deploy.sh          全量：test + build → rsync 代码与 config.json →（依赖变了才）npm ci → 重启
#   ./deploy.sh config   只改了配置：本地校验 config.json → 同步过去 → reload（不重启，在跑的任务不受影响）
#
# config.json 的真源就是本仓库这份（不含密钥）：改配置一律先改仓库、提交，再用上面的命令同步。
# 别直接改 VPS 上的 /opt/engine-router/config.json——下次部署会被覆盖。
# 重启不杀正在跑的任务（unit 里 KillMode=process，runner 是 detached 子进程）。
set -euo pipefail
VPS="${VPS:-root@66.42.45.128}"
REMOTE="${REMOTE:-/opt/engine-router}"
MODE="${1:-all}"

cd "$(dirname "$0")"

sync_config() {
  rsync -az config.json "$VPS:$REMOTE/config.json"
  ssh "$VPS" "chown engine-router:engines $REMOTE/config.json && chmod 640 $REMOTE/config.json"
}

if [ "$MODE" = "config" ]; then
  echo "▸ 校验 config.json"
  node --import tsx --test --test-force-exit test/config-file.test.ts >/dev/null || {
    echo "✗ config.json 校验没过：node --import tsx --test test/config-file.test.ts 看详情"
    exit 1
  }
  echo "▸ sync config.json → $VPS:$REMOTE"
  sync_config
  echo "▸ reload"
  # SIGHUP：server 重读 config.json + .env；配置坏了会记 reload failed 并保留旧配置
  ssh "$VPS" "since=\$(date '+%Y-%m-%d %H:%M:%S'); systemctl reload engine-router; sleep 2;
    log=\$(journalctl -u engine-router --since \"\$since\" --no-pager -o cat | grep -E 'reloaded config|reload failed' | tail -1);
    echo \"  \$log\"; echo \"\$log\" | grep -q 'reloaded config'"
  echo "✓ config deployed"
  exit 0
fi

echo "▸ test + build"
npm test
npm run build

echo "▸ sync → $VPS:$REMOTE"
rsync -az --delete dist/ "$VPS:$REMOTE/dist/"
rsync -az package.json package-lock.json "$VPS:$REMOTE/"
rsync -az --delete deploy/ "$VPS:$REMOTE/deploy/"
sync_config

echo "▸ deps + restart"
# lockfile 没变就不 npm ci：runner 换账号时会从 node_modules 起 claude CLI，装依赖那几秒会撞上。
ssh "$VPS" "set -e; cd $REMOTE
  chown -R engine-router:engines dist deploy package.json package-lock.json
  if ! cmp -s package-lock.json node_modules/.deployed-lock 2>/dev/null; then
    echo '  npm ci'; sudo -u engine-router HOME=$REMOTE npm ci --omit=dev --no-audit --no-fund --silent
    sudo -u engine-router cp package-lock.json node_modules/.deployed-lock
  fi
  systemctl restart engine-router && sleep 1 && systemctl --no-pager status engine-router | head -6"
echo "✓ deployed"
