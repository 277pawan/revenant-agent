#!/usr/bin/env bash
# Build agent image with Go CLI baked in (Phase 5.1).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$(cd "$ROOT/../revenant-cli" && pwd)"
TAG="${1:-revenant-agent:local}"
API_URL="${REVENANT_API_URL:-http://127.0.0.1:8080}"

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon not reachable. Run:"
  echo "  sudo usermod -aG docker \"\$USER\""
  echo "  newgrp docker"
  exit 1
fi

if [[ ! -f "$CLI/go.mod" ]]; then
  echo "Expected CLI at $CLI"
  exit 1
fi

echo "CLI context: $CLI"
echo "Tag:         $TAG"
echo "API URL:     $API_URL"

docker build \
  --build-context cli-src="$CLI" \
  --build-arg REVENANT_API_URL="$API_URL" \
  -t "$TAG" \
  "$ROOT"

echo "Default API baked into this local tag: $API_URL"
echo
echo "Laptop (you): token + --add-host (localhost is inside the container otherwise)"
echo "  docker run --rm --add-host=host.docker.internal:host-gateway \\"
echo "    -e REVENANT_API_URL=http://host.docker.internal:8080 \\"
echo "    -e REVENANT_RUNNER_TOKEN=rvn_... $TAG"
echo
echo "Customers after publish: token only (API baked in publish script)."
echo "  ./scripts/publish-agent-image.sh 277pawan/revenant-agent:0.1.0"
