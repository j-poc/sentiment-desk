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

# This script exercises real, keyless providers. Never self-approve a source in
# the verifier: require the operator to attest to every source it will contact.
required_sources="google_news_rss,yahoo_finance_rss,gdelt_doc_api,yahoo_quote,yahoo_chart"
if [ "${SOURCE_RIGHTS_APPROVED_COLLECTORS:-}" != "$required_sources" ]; then
  echo "Set SOURCE_RIGHTS_APPROVED_COLLECTORS to exactly this list only after clearing each source: $required_sources" >&2
  exit 2
fi

# This isolated Compose file never reads the developer's .env. It deliberately
# opts into keyless live-source HTTP reads; the source-use approvals come only
# from the explicit operator environment value above. Both classifiers and
# optional APIs are explicitly disabled, regardless of the developer environment.
cat >"$compose_file" <<EOF
services:
  sentiment-desk:
    build:
      context: "$repo_root"
    environment:
      HOST: "0.0.0.0"
      PORT: "8787"
      DB_PATH: /app/data/desk.db
      EXTERNAL_REQUESTS_ENABLED: "true"
      EXTERNAL_SOURCE_COLLECTORS: "google_news_rss,yahoo_finance_rss,gdelt_doc_api,yahoo_quote,yahoo_chart"
      SOURCE_RIGHTS_APPROVED_COLLECTORS: "$SOURCE_RIGHTS_APPROVED_COLLECTORS"
      TYPESAFE_ACCOUNT_USE_APPROVED: "false"
      TYPESAFE_API_KEY: ""
      CLASSIFICATION_PROVIDER: "openai_luna"
      OPENAI_API_KEY: ""
      OPENAI_ACCOUNT_USE_APPROVED: "false"
      OPENAI_ALLOWED_COLLECTORS: ""
      OPENAI_MAX_REQUESTS_PER_DAY: "0"
      OPENAI_MAX_REQUEST_BYTES_PER_DAY: "0"
      OPENAI_MAX_DAILY_COST_USD: "0"
      FINNHUB_API_KEY: ""
      REDDIT_CLIENT_ID: ""
      REDDIT_CLIENT_SECRET: ""
      X_BEARER_TOKEN: ""
      ALERT_WEBHOOK_URL: ""
    ports:
      - "127.0.0.1::8787"
    volumes:
      - desk-data:/app/data
volumes:
  desk-data:
EOF

compose() {
  docker compose --project-name "$project" --file "$compose_file" "$@"
}

run_host_api_check() {
  host_port=$(compose port sentiment-desk 8787 | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p')
  if [ -z "$host_port" ]; then
    echo "Compose did not publish the service on a loopback-only host port." >&2
    return 1
  fi
  SMOKE_HOST_PORT="$host_port" node --input-type=module - <<'NODE'
const port = process.env.SMOKE_HOST_PORT;
const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5_000) });
if (!response.ok) throw new Error(`host-published health endpoint returned HTTP ${response.status}`);
const health = await response.json();
if (Object.hasOwn(health, "demo") || health.dbSizeBytes <= 0) throw new Error("host-published API returned unexpected health state");
console.log(`HOST_API_SMOKE_RESULT host=127.0.0.1:${port} health=200 dbSizeBytes=${health.dbSizeBytes}`);
NODE
}

run_api_check() {
  mode=$1
  min_db_bytes=${2:-0}
  compose exec -T \
  -e "SMOKE_MODE=$mode" \
  -e "SMOKE_DB_MIN_BYTES=$min_db_bytes" \
    -e "SMOKE_OBSERVATION_ID=${3:-}" \
    sentiment-desk node --input-type=module - <<'NODE'
const mode = process.env.SMOKE_MODE;
const minDbBytes = Number(process.env.SMOKE_DB_MIN_BYTES ?? 0);
const expectedObservationId = process.env.SMOKE_OBSERVATION_ID ?? "";
const deadline = Date.now() + (mode === "live" ? 600_000 : 120_000);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let last = "API is not ready";

while (Date.now() < deadline) {
  try {
    const [healthResponse, quotesResponse, companiesResponse, tapeResponse] = await Promise.all([
      fetch("http://127.0.0.1:8787/api/health", { signal: AbortSignal.timeout(2_000) }),
      fetch("http://127.0.0.1:8787/api/quotes", { signal: AbortSignal.timeout(2_000) }),
      fetch("http://127.0.0.1:8787/api/companies", { signal: AbortSignal.timeout(2_000) }),
      fetch("http://127.0.0.1:8787/api/tape?limit=100", { signal: AbortSignal.timeout(2_000) }),
    ]);
    if (!healthResponse.ok || !quotesResponse.ok || !companiesResponse.ok || !tapeResponse.ok) {
      throw new Error("consumer API returned a non-success response");
    }
    const [health, quotes, companies, tape] = await Promise.all([
      healthResponse.json(),
      quotesResponse.json(),
      companiesResponse.json(),
      tapeResponse.json(),
    ]);
    if (Object.hasOwn(health, "demo")) throw new Error("Synthetic-mode health leaked into the live API");
    if (health.health?.jev?.enabled !== false) throw new Error("Jev should be disabled in this credential-free smoke check");
    if (health.health?.classifier?.provider !== "openai_luna" || health.health.classifier.enabled !== false) throw new Error("Luna should be selected and disabled in this credential-free smoke check");
    if (health.classifierUsage?.requests !== 0) throw new Error("Credential-free source verification must not dispatch a paid classification");

    if (mode === "live") {
      const quoteCount = Object.keys(quotes.quotes ?? {}).length;
      const sourceDelivery = (health.deliveries ?? []).find((delivery) =>
        ["google_news_rss", "yahoo_finance_rss", "gdelt_doc_api", "sec_edgar"].includes(delivery.collector)
        && ["success", "empty", "partial"].includes(delivery.result),
      );
      const pending = (tape ?? []).find((mention) =>
        mention.status === "pending" && ["rss", "sec"].includes(mention.source?.kind),
      );
      const operationalSource = (health.deliveryHealth ?? []).find((source) =>
        ["google_news_rss", "yahoo_finance_rss", "gdelt_doc_api", "sec_edgar"].includes(source.collector)
        && source.state === "current" && source.coverageCount >= source.targetCount,
      );
      const quoteSource = (health.deliveryHealth ?? []).find((source) =>
        source.collector === "yahoo_quote" && source.state === "current" && source.coverageCount >= source.targetCount,
      );
      if (quoteCount > 0 && quoteSource && sourceDelivery && operationalSource && pending && companies.length > 0 && health.dbSizeBytes > 0) {
        console.log(`LIVE_SMOKE_RESULT quotes=${quoteCount} companies=${companies.length} dbSizeBytes=${health.dbSizeBytes} pendingId=${pending.id} collector=${pending.collector} timeBasis=${pending.timeBasis}`);
        break;
      }
      last = `waiting for live quotes, a current public collector sweep, and a real keyless pending news/filing observation (quotes=${quoteCount}, deliveries=${health.deliveries?.length ?? 0}, tape=${tape?.length ?? 0})`;
    } else {
      const persisted = expectedObservationId && (tape ?? []).some((mention) => mention.id === expectedObservationId && mention.status === "pending");
      if (persisted && health.dbSizeBytes >= minDbBytes && health.dbSizeBytes > 0 && companies.length > 0) {
        console.log(`RECOVERY_SMOKE_RESULT companies=${companies.length} dbSizeBytes=${health.dbSizeBytes} pendingObservationPreserved=true`);
        break;
      }
      last = `persisted observation not ready (size=${health.dbSizeBytes}, expectedAtLeast=${minDbBytes}, observationPresent=${Boolean(persisted)})`;
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
printf '%s\n' "$live_result"
run_host_api_check
db_size=$(printf '%s\n' "$live_result" | sed -n 's/^LIVE_SMOKE_RESULT .*dbSizeBytes=\([0-9][0-9]*\).*$/\1/p')
observation_id=$(printf '%s\n' "$live_result" | sed -n 's/^LIVE_SMOKE_RESULT .*pendingId=\([^ ]*\).*$/\1/p')
if [ -z "$db_size" ] || [ -z "$observation_id" ]; then
  echo "Live smoke did not return a persisted pending observation and database size." >&2
  exit 1
fi

echo "Recreating the container while retaining its isolated database volume..."
compose down
compose up -d
run_api_check recovery "$db_size" "$observation_id"
run_host_api_check
echo "Live Compose smoke and persistent-volume recovery passed."
