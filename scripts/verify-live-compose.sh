#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
project="sentiment-desk-smoke-$$"
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/sentiment-desk-smoke.XXXXXX")
compose_file="$tmp_dir/compose.yaml"

cleanup() {
  docker compose --project-name "$project" --file "$compose_file" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$tmp_dir"
}
trap cleanup EXIT HUP INT TERM

# This isolated Compose file never reads the developer's .env. The check uses
# only keyless live sources and cannot spend Jev credits or call optional APIs.
cat >"$compose_file" <<EOF
services:
  sentiment-desk:
    build:
      context: "$repo_root"
    environment:
      PORT: "8787"
      DB_PATH: /app/data/desk.db
      DEMO: "0"
      TYPESAFE_API_KEY: ""
      FINNHUB_API_KEY: ""
      REDDIT_CLIENT_ID: ""
      REDDIT_CLIENT_SECRET: ""
      X_BEARER_TOKEN: ""
      ALERT_WEBHOOK_URL: ""
    volumes:
      - desk-data:/app/data
volumes:
  desk-data:
EOF

compose() {
  docker compose --project-name "$project" --file "$compose_file" "$@"
}

run_api_check() {
  mode=$1
  min_db_bytes=${2:-0}
  compose exec -T \
    -e "SMOKE_MODE=$mode" \
    -e "SMOKE_DB_MIN_BYTES=$min_db_bytes" \
    sentiment-desk node --input-type=module - <<'NODE'
const mode = process.env.SMOKE_MODE;
const minDbBytes = Number(process.env.SMOKE_DB_MIN_BYTES ?? 0);
const deadline = Date.now() + 120_000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let last = "API is not ready";

while (Date.now() < deadline) {
  try {
    const [healthResponse, quotesResponse, companiesResponse] = await Promise.all([
      fetch("http://127.0.0.1:8787/api/health", { signal: AbortSignal.timeout(2_000) }),
      fetch("http://127.0.0.1:8787/api/quotes", { signal: AbortSignal.timeout(2_000) }),
      fetch("http://127.0.0.1:8787/api/companies", { signal: AbortSignal.timeout(2_000) }),
    ]);
    if (!healthResponse.ok || !quotesResponse.ok || !companiesResponse.ok) {
      throw new Error("consumer API returned a non-success response");
    }
    const [health, quotes, companies] = await Promise.all([
      healthResponse.json(),
      quotesResponse.json(),
      companiesResponse.json(),
    ]);
    if (health.demo !== false) throw new Error("DEMO mode is enabled");
    if (health.health?.jev?.enabled !== false) throw new Error("Jev should be disabled in this credential-free smoke check");

    if (mode === "live") {
      const quoteCount = Object.keys(quotes.quotes ?? {}).length;
      const sourceOk = (health.health?.rss?.ok ?? 0) > 0 || (health.health?.sec?.ok ?? 0) > 0;
      if (quoteCount > 0 && sourceOk && companies.length > 0 && health.dbSizeBytes > 0) {
        console.log(`LIVE_SMOKE_RESULT quotes=${quoteCount} companies=${companies.length} dbSizeBytes=${health.dbSizeBytes}`);
        break;
      }
      last = `waiting for live quotes and a news/filing source (quotes=${quoteCount}, rssOk=${health.health?.rss?.ok ?? 0}, secOk=${health.health?.sec?.ok ?? 0})`;
    } else {
      if (health.dbSizeBytes >= minDbBytes && health.dbSizeBytes > 0 && companies.length > 0) {
        console.log(`RECOVERY_SMOKE_RESULT companies=${companies.length} dbSizeBytes=${health.dbSizeBytes}`);
        break;
      }
      last = `persistent database not ready (size=${health.dbSizeBytes}, expectedAtLeast=${minDbBytes})`;
    }
  } catch (error) {
    last = error instanceof Error ? error.message : String(error);
  }
  await pause(1_000);
}

if (Date.now() >= deadline) throw new Error(`timed out: ${last}`);
NODE
}

echo "Building an isolated live-data image with no provider credentials..."
compose up -d --build
live_result=$(run_api_check live 0)
printf '%s\n' "$live_result" | sed '/^LIVE_SMOKE_RESULT /d'
db_size=$(printf '%s\n' "$live_result" | sed -n 's/^LIVE_SMOKE_RESULT .*dbSizeBytes=\([0-9][0-9]*\)$/\1/p')
if [ -z "$db_size" ]; then
  echo "Live smoke did not return a database size." >&2
  exit 1
fi

echo "Recreating the container while retaining its isolated database volume..."
compose down
compose up -d
run_api_check recovery "$db_size"
echo "Live Compose smoke and persistent-volume recovery passed."
