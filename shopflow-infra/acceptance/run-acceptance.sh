#!/usr/bin/env sh
#
# Black-box acceptance driver for the composed ShopFlow stack (owner: shopflow-infra).
#
#   1. docker compose down -v --remove-orphans   fresh volumes -> reproducible seed state
#   2. docker compose up -d --build
#   3. wait until db, notification-provider, api and web report healthy
#   4. phase 1: behavior-preservation (requirements 1-9) + concurrency invariant
#   5. restart durability: prepare -> `docker compose restart api` -> verify
#   6. provider outage: stop -> pending -> start -> recovered
#   7. pass/fail summary, non-zero exit on any failure
#
# The stack is left running with its volumes intact, so a failure can be inspected; pass `--down` to
# finish with `docker compose down` (never `-v`) when you do not need the state.
#
# Usage: ./run-acceptance.sh [--down]
# Environment: ACCEPTANCE_BASE_URL (default http://web), API_HEALTH_TIMEOUT (seconds, default 300),
#              OUTBOX_RELAY_INTERVAL_MS (must match the api's relay interval, default 10000),
#              DURABILITY_ORDER_TAG (default: the current epoch second).
set -u

# Git Bash / MSYS2 rewrite arguments that look like POSIX paths (for example http://web inside an
# -e value) before handing them to docker.exe. These two switches keep the container arguments
# intact; every other shell ignores them.
MSYS_NO_PATHCONV=1
MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV MSYS2_ARG_CONV_EXCL

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR" || exit 1

DOWN=0
for argument in "$@"; do
  case "$argument" in
    --down) DOWN=1 ;;
    -h | --help)
      echo "usage: run-acceptance.sh [--down]"
      exit 0
      ;;
    *)
      echo "run-acceptance.sh: unknown argument: $argument" >&2
      echo "usage: run-acceptance.sh [--down]" >&2
      exit 2
      ;;
  esac
done

HEALTH_TIMEOUT="${API_HEALTH_TIMEOUT:-300}"
RELAY_MS="${OUTBOX_RELAY_INTERVAL_MS:-10000}"
ORDER_TAG="${DURABILITY_ORDER_TAG:-$(date +%s)}"
BASE_URL_VALUE="${ACCEPTANCE_BASE_URL:-http://web}"

SUMMARY=""
FAILURES=0

record() {
  if [ "$1" -eq 0 ]; then
    SUMMARY="${SUMMARY}$(printf '%-56s %s' "$2" "PASS")
"
  else
    SUMMARY="${SUMMARY}$(printf '%-56s %s' "$2" "FAIL (exit $1)")
"
    FAILURES=$((FAILURES + 1))
  fi
}

print_summary() {
  echo
  echo "======================== acceptance summary ========================"
  printf '%s' "$SUMMARY"
  echo "===================================================================="
  if [ "$FAILURES" -eq 0 ]; then
    echo "RESULT: PASS - every acceptance phase is green"
  else
    echo "RESULT: FAIL - $FAILURES phase(s) failed"
  fi
  echo
}

fail_fast() {
  print_summary
  echo "The stack and its volumes were kept for inspection."
  echo "Reset with: docker compose down -v --remove-orphans"
  exit 1
}

compose_health() {
  container_id=$(docker compose ps -q "$1" 2>/dev/null)
  if [ -z "$container_id" ]; then
    echo "missing"
    return 0
  fi
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || echo "unknown"
}

wait_for_healthy() {
  service="$1"
  timeout="$2"
  deadline=$(( $(date +%s) + timeout ))
  printf '  waiting for %s to report healthy' "$service"
  while :; do
    current=$(compose_health "$service")
    if [ "$current" = "healthy" ]; then
      printf ' ok\n'
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      printf ' timed out (last status: %s)\n' "$current"
      return 1
    fi
    printf '.'
    sleep 2
  done
}

run_tests() {
  label="$1"
  phase="$2"
  shift 2
  echo
  echo "--- $label"
  if [ -n "$phase" ]; then
    docker compose run --rm --no-deps \
      -e "BASE_URL=$BASE_URL_VALUE" \
      -e "DURABILITY_PHASE=$phase" \
      -e "DURABILITY_ORDER_TAG=$ORDER_TAG" \
      -e "OUTBOX_RELAY_INTERVAL_MS=$RELAY_MS" \
      acceptance node --test --test-concurrency=1 "$@"
  else
    docker compose run --rm --no-deps \
      -e "BASE_URL=$BASE_URL_VALUE" \
      -e "DURABILITY_ORDER_TAG=$ORDER_TAG" \
      -e "OUTBOX_RELAY_INTERVAL_MS=$RELAY_MS" \
      acceptance node --test --test-concurrency=1 "$@"
  fi
  return $?
}

echo "=== shopflow acceptance run (tag $ORDER_TAG, origin $BASE_URL_VALUE) ==="

echo
echo "--- reset: docker compose down -v --remove-orphans"
docker compose down -v --remove-orphans >/dev/null 2>&1 || true

echo "--- start: docker compose up -d --build"
docker compose up -d --build
record "$?" "startup: docker compose up -d --build"
if [ "$FAILURES" -ne 0 ]; then fail_fast; fi

echo
echo "--- health: db, notification-provider, api, web"
for service in db notification-provider api web; do
  if ! wait_for_healthy "$service" "$HEALTH_TIMEOUT"; then
    record 1 "health: $service"
    fail_fast
  fi
done
record 0 "health: db, notification-provider, api, web healthy"

run_tests "phase 1: preserved behaviour (requirements 1-9) and the concurrency invariant" "" tests/behavior-preservation.test.mjs tests/concurrency.test.mjs
phase_one_status=$?
record "$phase_one_status" "phase 1: behavior-preservation + concurrency"
if [ "$phase_one_status" -ne 0 ]; then fail_fast; fi

run_tests "durability prepare: order created before the api restart" "prepare" tests/restart-durability.test.mjs
prepare_status=$?
record "$prepare_status" "durability: prepare (pre-restart order)"
if [ "$prepare_status" -ne 0 ]; then fail_fast; fi

echo
echo "--- restart api: docker compose restart api"
docker compose restart api
restart_status=$?
record "$restart_status" "infrastructure: docker compose restart api"
if [ "$restart_status" -ne 0 ]; then fail_fast; fi

if ! wait_for_healthy api "$HEALTH_TIMEOUT"; then
  record 1 "health: api after restart"
  fail_fast
fi
record 0 "health: api healthy after restart"

run_tests "durability verify: post-restart durability and no duplicated notifications" "verify" tests/restart-durability.test.mjs
verify_status=$?
record "$verify_status" "durability: verify (post-restart durability)"
if [ "$verify_status" -ne 0 ]; then fail_fast; fi

echo
echo "--- fault injection: docker compose stop notification-provider"
docker compose stop notification-provider
stop_status=$?
record "$stop_status" "infrastructure: notification-provider stopped"
if [ "$stop_status" -ne 0 ]; then fail_fast; fi

run_tests "durability pending: order committed while the provider is unreachable" "pending" tests/restart-durability.test.mjs
pending_status=$?
record "$pending_status" "durability: pending (post-commit failure path)"
if [ "$pending_status" -ne 0 ]; then fail_fast; fi

echo
echo "--- recovery: docker compose start notification-provider"
docker compose start notification-provider
start_status=$?
record "$start_status" "infrastructure: notification-provider started"
if [ "$start_status" -ne 0 ]; then fail_fast; fi

if ! wait_for_healthy notification-provider "$HEALTH_TIMEOUT"; then
  record 1 "health: notification-provider after restart"
  fail_fast
fi
record 0 "health: notification-provider healthy again"

run_tests "durability recovered: the relay delivers the pending intent exactly once" "recovered" tests/restart-durability.test.mjs
recovered_status=$?
record "$recovered_status" "durability: recovered (relay delivers exactly once)"
if [ "$recovered_status" -ne 0 ]; then fail_fast; fi

print_summary

if [ "$DOWN" -eq 1 ]; then
  echo "--- shutdown: docker compose down --remove-orphans"
  docker compose down --remove-orphans
fi

echo "Inspect the stack at: docker compose ps / http://127.0.0.1:3000"
echo "Full cleanup: docker compose down -v --remove-orphans"
exit 0
