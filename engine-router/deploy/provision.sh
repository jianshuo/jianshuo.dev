#!/usr/bin/env bash
# 首次开服 —— 在 VPS 上以 root 跑，幂等。Node/Caddy/codex CLI 这台机器已有。
# 只建用户/组、目录、unit；密钥和 config.json 见 README「首次配置」。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT=/opt/engine-router

echo "▸ group engines + user engine-router"
getent group engines >/dev/null || groupadd --system engines
id -u engine-router >/dev/null 2>&1 || useradd --system --home "$ROOT" --gid engines --shell /usr/sbin/nologin engine-router
# caddy 要能连 socket（/run/engine-router 是 0750 engines）
id -nG caddy | grep -qw engines || usermod -aG engines caddy

echo "▸ dirs"
mkdir -p "$ROOT"/{state,work,accounts}
chown -R engine-router:engines "$ROOT"
chmod 750 "$ROOT"

echo "▸ systemd unit"
install -m 644 "$HERE/engine-router.service" /etc/systemd/system/engine-router.service
systemctl daemon-reload
systemctl enable engine-router >/dev/null

echo "▸ Caddy（手动步骤，见 $HERE/Caddyfile.snippet）：lab.jianshuo.dev 块里加 /router/* 反代，"
echo "  basic_auth 豁免 /router/v1/*；改完 caddy reload --config /etc/caddy/Caddyfile"
echo "  （这台机 systemctl reload caddy 会报 mount namespacing，用 caddy reload）"
echo "  加组后 caddy 要 systemctl restart caddy 一次才拿到新组。"
echo "✓ provisioned"
