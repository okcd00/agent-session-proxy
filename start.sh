#!/usr/bin/env bash
# 启动 agent-session-proxy。
#
#   ./start.sh                      用 config.json 里的口令；没有就生成一个随机的存进去
#   ./start.sh 我自己的口令           用你给的口令
#   ./start.sh 我自己的口令 -p 9000   口令 + 其它 server.js 参数
#   ASP_TOKEN=xxx ./start.sh        用环境变量给口令（不会出现在 ps 里）
#   ASP_ADMIN_TOKEN=yyy ./start.sh  指定控制台的管理口令（不给就自动生成并存下来）
#
# 注意：命令行传口令会被同机其它用户通过 `ps` 看到，介意就用 ASP_TOKEN。
set -euo pipefail

cd "$(dirname "$0")"

TOKEN=''
SOURCE=''

if [[ $# -gt 0 && "$1" != -* ]]; then
  TOKEN="$1"
  shift
  SOURCE='命令行'
elif [[ -n "${ASP_TOKEN:-}" ]]; then
  TOKEN="$ASP_TOKEN"
  SOURCE='环境变量 ASP_TOKEN'
fi

if [[ -n "$SOURCE" && -z "$TOKEN" ]]; then
  echo "口令不能为空" >&2
  exit 1
fi

if [[ -n "$SOURCE" ]]; then
  echo "口令来源：$SOURCE"
else
  # No baked-in fallback: a passphrase committed to the repo is a public one.
  echo "口令来源：config.json（没有就现场生成一个随机口令并存进去）"
fi

# Explicit branches rather than an args array: `"${arr[@]}"` on an empty array is
# an unbound-variable error under `set -u` in bash 3.2, which is what macOS ships.
if [[ -n "$TOKEN" && -n "${ASP_ADMIN_TOKEN:-}" ]]; then
  exec node server.js --token "$TOKEN" --admin-token "$ASP_ADMIN_TOKEN" "$@"
elif [[ -n "$TOKEN" ]]; then
  exec node server.js --token "$TOKEN" "$@"
elif [[ -n "${ASP_ADMIN_TOKEN:-}" ]]; then
  exec node server.js --admin-token "$ASP_ADMIN_TOKEN" "$@"
fi

exec node server.js "$@"
