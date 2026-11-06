#!/usr/bin/env bash
#
# ChatGPT Login 一键启动脚本
#
# 用法:
#   ./start.sh                        后台启动（日志写入 logs/app.log）
#   ./start.sh start                  后台启动（同上，显式写法）
#   ./start.sh run                    前台启动（Ctrl+C 退出，带选项时默认前台）
#   ./start.sh stop                   停止后台服务
#   ./start.sh restart                重启后台服务
#   ./start.sh status                 查看运行状态
#   ./start.sh logs [-f]              查看日志（-f 持续跟踪）
#
# 选项（放在命令后面）:
#   --headed       使用有头浏览器（等同 HEADLESS_OVERRIDE=0）
#   --port <端口>  覆盖端口（等同 PORT，默认取 config.json 的 3210）
#   --no-open      不自动打开浏览器（等同 NO_AUTO_OPEN=1）
#   --no-install   跳过依赖自检（不装 node_modules / Chromium）
#   --timeout <秒> 前台启动时等待面板就绪的秒数（默认 60）
#

set -euo pipefail

# ---- 定位项目根目录（脚本所在目录） ----
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR"

ENTRY="src/index.js"
LOG_DIR="$SCRIPT_DIR/logs"
LOG_FILE="$LOG_DIR/app.log"
PID_FILE="$LOG_DIR/app.pid"

# ---- 终端颜色（非 TTY 时不着色） ----
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'; C_DIM=$'\033[2m'
else
  C_RESET=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''; C_DIM=''
fi

info()  { printf '%s%s%s\n' "$C_CYAN"   "$*" "$C_RESET"; }
ok()    { printf '%s%s%s\n' "$C_GREEN"  "$*" "$C_RESET"; }
warn()  { printf '%s%s%s\n' "$C_YELLOW" "$*" "$C_RESET"; }
err()   { printf '%s%s%s\n' "$C_RED"    "$*" "$C_RESET" >&2; }
dim()   { printf '%s%s%s\n' "$C_DIM"    "$*" "$C_RESET"; }
die()   { err "错误: $*"; exit 1; }

usage() {
  # 打印文件头注释（跳过 shebang），去掉行首 "# "
  sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' | sed '1d'
}

# ---- 参数默认值 ----
COMMAND=""
HEADLESS_ENV=""
PORT_OVERRIDE=""
NO_AUTO_OPEN_ENV=""
SKIP_INSTALL=0
START_TIMEOUT=60
FOLLOW_LOGS=0

# 若第一个参数不是命令，则视为默认 start（后台）；带 --help 等选项时默认前台
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      start|run|dev|stop|restart|status|logs)
        COMMAND="$1"; shift ;;
      --headed|headed|-h-headed)
        HEADLESS_ENV="0"; shift ;;
      --headless)
        HEADLESS_ENV="1"; shift ;;
      --port)
        [[ $# -ge 2 ]] || die "--port 需要端口号"
        PORT_OVERRIDE="$2"; shift 2 ;;
      --port=*)
        PORT_OVERRIDE="${1#*=}"; shift ;;
      --no-open)
        NO_AUTO_OPEN_ENV="1"; shift ;;
      --no-install)
        SKIP_INSTALL=1; shift ;;
      --timeout)
        [[ $# -ge 2 ]] || die "--timeout 需要秒数"
        START_TIMEOUT="$2"; shift 2 ;;
      -f|--follow)
        FOLLOW_LOGS=1; shift ;;
      --help|-h|help)
        usage; exit 0 ;;
      *)
        err "未知参数: $1"; echo; usage; exit 2 ;;
    esac
  done

  if [[ -z "$COMMAND" ]]; then
    # 无命令时：带到前台选项就前台运行，否则后台运行
    if [[ -n "$HEADLESS_ENV$PORT_OVERRIDE$NO_AUTO_OPEN_ENV" || "$SKIP_INSTALL" == "1" ]]; then
      COMMAND="run"
    else
      COMMAND="start"
    fi
  fi

  if [[ -n "$PORT_OVERRIDE" ]]; then
    [[ "$PORT_OVERRIDE" =~ ^[0-9]+$ ]] && (( PORT_OVERRIDE >= 1 && PORT_OVERRIDE <= 65535 )) \
      || die "端口必须是 1–65535 的整数: $PORT_OVERRIDE"
  fi
  [[ "$START_TIMEOUT" =~ ^[0-9]+$ ]] || die "--timeout 必须是整数秒"
}

# ---- 读取端口（与 src/index.js 保持同一优先级：PORT > config.json > 3210） ----
resolve_port() {
  if [[ -n "$PORT_OVERRIDE" ]]; then
    echo "$PORT_OVERRIDE"
  elif [[ -n "${PORT:-}" ]]; then
    echo "$PORT"
  else
    local cfg_port=""
    if [[ -f config.json ]]; then
      cfg_port="$(node -e 'try{const p=require("./config.json").port;if(Number.isInteger(p))process.stdout.write(String(p))}catch{}' 2>/dev/null || true)"
    fi
    echo "${cfg_port:-3210}"
  fi
}

# ---- 依赖自检 ----
check_node() {
  command -v node >/dev/null 2>&1 || die "未找到 node，请先安装 Node.js 18+（https://nodejs.org）"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  (( major >= 18 )) || die "Node.js 版本过低（当前 $(node -v)），需要 18 及以上"
}

ensure_deps() {
  local need_install=0

  if [[ ! -d node_modules/playwright ]]; then
    warn "未安装依赖，正在执行 npm install …"
    npm install || die "npm install 失败"
    need_install=1
  fi

  # 检查 Playwright 对应的 Chromium 是否就绪，缺失时补装
  if ! node -e 'const{chromium}=require("playwright");process.exit(require("fs").existsSync(chromium.executablePath())?0:1)' 2>/dev/null; then
    warn "未找到 Playwright Chromium 浏览器，正在安装 …"
    npx --yes playwright install chromium || die "Playwright Chromium 安装失败"
    need_install=1
  fi

  [[ "$need_install" == "1" ]] && ok "依赖已就绪"
  return 0
}

# ---- 进程 / 端口状态 ----
read_pid() {
  local pid=""
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  fi
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "$pid"
  else
    return 1
  fi
}

# 端口上是否有监听进程（输出 PID，没有则返回 1）
port_pid() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n1
}

wait_ready() {
  local port="$1" timeout="$2" i=0 url="http://127.0.0.1:$port/"
  for (( i = 0; i < timeout * 5; i++ )); do
    if curl -fsS -m 2 -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

is_our_entry() {
  local pid="$1"
  ps -p "$pid" -o command= 2>/dev/null | grep -Fq "src/index.js"
}

# ---- 命令实现 ----
cmd_run() {
  check_node
  [[ "$SKIP_INSTALL" == "1" ]] || ensure_deps
  [[ -f "$ENTRY" ]] || die "找不到入口文件 $ENTRY"

  local port; port="$(resolve_port)"
  local port_owner; port_owner="$(port_pid "$port" || true)"
  if [[ -n "$port_owner" ]]; then
    warn "端口 $port 已被进程 $port_owner 占用"
    warn "如果是旧服务，运行 ./start.sh stop 后再启动，或用 --port 指定其他端口"
    die "启动中止"
  fi

  echo "$port" > "$LOG_DIR/.last_port" 2>/dev/null || true
  info "启动 ChatGPT 批量登录服务（前台）"
  dim "  项目:  $SCRIPT_DIR"
  dim "  面板:  http://localhost:$port"
  dim "  退出:  Ctrl+C"
  echo

  PORT="$port" \
  HEADLESS_OVERRIDE="${HEADLESS_ENV:-${HEADLESS_OVERRIDE:-}}" \
  NO_AUTO_OPEN="${NO_AUTO_OPEN_ENV:-${NO_AUTO_OPEN:-}}" \
    exec node "$ENTRY"
}

cmd_start() {
  check_node
  [[ "$SKIP_INSTALL" == "1" ]] || ensure_deps
  [[ -f "$ENTRY" ]] || die "找不到入口文件 $ENTRY"

  local port; port="$(resolve_port)"

  # 已在运行则直接提示
  local existing; existing="$(read_pid || true)"
  if [[ -n "$existing" ]]; then
    ok "服务已在运行（PID ${existing}）"
    dim "  面板: http://localhost:$(run_and_port_of "$existing" || echo "$port")"
    dim "  日志: $LOG_FILE"
    return 0
  fi

  local port_owner; port_owner="$(port_pid "$port" || true)"
  if [[ -n "$port_owner" ]]; then
    die "端口 $port 已被进程 $port_owner 占用（可运行 ./start.sh stop 或使用 --port 换端口）"
  fi

  mkdir -p "$LOG_DIR"
  echo "$port" > "$LOG_DIR/.last_port"

  {
    echo
    echo "===== $(date '+%Y-%m-%d %H:%M:%S') 启动（端口 $port${HEADLESS_ENV:+，headless=$HEADLESS_ENV}${NO_AUTO_OPEN_ENV:+，不自动打开浏览器}） ====="
  } >> "$LOG_FILE"

  # 后台启动：独立会话，关闭终端不影响；日志追加到文件
  PORT="$port" \
  HEADLESS_OVERRIDE="${HEADLESS_ENV:-${HEADLESS_OVERRIDE:-}}" \
  NO_AUTO_OPEN="${NO_AUTO_OPEN_ENV:-${NO_AUTO_OPEN:-}}" \
    nohup node "$ENTRY" >> "$LOG_FILE" 2>&1 &

  local pid=$!
  echo "$pid" > "$PID_FILE"

  info "正在启动（PID ${pid}），等待面板就绪 …"
  if wait_ready "$port" "$START_TIMEOUT"; then
    ok "✔ 启动成功"
    echo "  面板:  http://localhost:$port"
    echo "  日志:  $LOG_FILE"
    echo "  停止:  ./start.sh stop"
  else
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      err "✘ 启动失败，进程已退出。最近的日志："
      echo
      tail -n 30 "$LOG_FILE" >&2 || true
      exit 1
    fi
    warn "面板在 ${START_TIMEOUT}s 内未响应，进程仍在运行（PID ${pid}）"
    dim "  可用 ./start.sh logs -f 查看日志，或 ./start.sh status 检查状态"
  fi
}

# 读取运行中进程的端口（无 PID 文件时用 .last_port / 端口探测）
run_and_port_of() {
  local pid="$1"
  local port=""
  if [[ -f "$LOG_DIR/.last_port" ]]; then port="$(cat "$LOG_DIR/.last_port" 2>/dev/null || true)"; fi
  if [[ -z "$port" ]]; then port="$(resolve_port)"; fi
  # 校验该 pid 是否真的监听端口
  if lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "$port"
  else
    echo "$port"
  fi
}

cmd_stop() {
  local pid; pid="$(read_pid || true)"
  if [[ -z "$pid" ]]; then
    # 没有 PID 文件时，尝试用端口上的进程兜底
    local port; port="$(resolve_port)"
    pid="$(port_pid "$port" || true)"
    if [[ -n "$pid" ]] && ! is_our_entry "$pid"; then
      die "PID 文件不存在，端口 $port 上是其他进程（PID ${pid}），不停止"
    fi
    if [[ -z "$pid" ]]; then
      warn "服务未在运行"
      rm -f "$PID_FILE"
      return 0
    fi
  fi

  info "正在停止（PID ${pid}）…"
  kill -TERM "$pid" 2>/dev/null || true

  # 等待优雅退出（最多 15 秒）
  for _ in $(seq 1 75); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done

  if kill -0 "$pid" 2>/dev/null; then
    warn "进程未响应 SIGTERM，改为强制结束"
    kill -KILL "$pid" 2>/dev/null || true
    sleep 0.5
  fi

  rm -f "$PID_FILE"
  ok "✔ 已停止"
}

cmd_restart() {
  cmd_stop
  # 等端口释放
  local port; port="$(resolve_port)"
  for _ in $(seq 1 25); do
    [[ -z "$(port_pid "$port" || true)" ]] && break
    sleep 0.2
  done
  cmd_start
}

cmd_status() {
  local pid; pid="$(read_pid || true)"
  local port; port="$(resolve_port)"

  if [[ -z "$pid" ]]; then
    warn "服务未运行"
    dim "  启动: ./start.sh start"
    return 1
  fi

  ok "服务运行中（PID ${pid}）"
  echo "  端口:  $port"
  echo "  目录:  $SCRIPT_DIR"

  # 运行时长与内存
  local etime rss
  etime="$(ps -p "$pid" -o etime= 2>/dev/null | tr -d ' ' || true)"
  rss="$(ps -p "$pid" -o rss= 2>/dev/null | tr -d ' ' || true)"
  [[ -n "$etime" ]] && echo "  运行:  $etime"
  [[ -n "$rss" ]] && echo "  内存:  $(( rss / 1024 )) MB"

  if lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "  面板:  http://localhost:$port"
    if curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then
      ok "  状态:  HTTP 正常"
    else
      warn "  状态:  端口在监听，但 HTTP 请求无响应"
    fi
  else
    warn "  状态:  进程存在但未监听端口"
  fi

  [[ -f "$LOG_FILE" ]] && echo "  日志:  $LOG_FILE"
}

cmd_logs() {
  if [[ ! -f "$LOG_FILE" ]]; then
    warn "还没有日志文件（服务可能从未后台启动）: $LOG_FILE"
    return 1
  fi
  if [[ "$FOLLOW_LOGS" == "1" ]]; then
    dim "跟踪 ${LOG_FILE}（Ctrl+C 退出）"
    tail -n 50 -f "$LOG_FILE"
  else
    tail -n 100 "$LOG_FILE"
  fi
}

# ---- 入口 ----
trap 'echo; warn "已取消"; exit 130' INT TERM

parse_args "$@"

case "$COMMAND" in
  run)     cmd_run ;;
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  dev)     cmd_run ;;
  *)       usage; exit 2 ;;
esac
