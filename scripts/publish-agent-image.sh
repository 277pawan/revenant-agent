#!/usr/bin/env bash
# Publish Hub image with production API URL baked in.
# Customers only pass REVENANT_RUNNER_TOKEN.
#
#   REVENANT_API_URL=https://api.yourdomain.com \
#     ./scripts/publish-agent-image.sh 277pawan/revenant-agent:0.1.0
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$(cd "$ROOT/../revenant-cli" && pwd)"
TAG="${1:-}"
API_URL="${REVENANT_API_URL:-}"

if [[ -z "$TAG" || -z "$API_URL" ]]; then
  echo "Usage:"
  echo "  REVENANT_API_URL=https://api.yourdomain.com $0 277pawan/revenant-agent:0.1.0"
  exit 1
fi

if [[ "$API_URL" == *"127.0.0.1"* || "$API_URL" == *"localhost"* ]]; then
  echo "Refusing to publish with a localhost API URL."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon not reachable. Add your user to the docker group first."
  exit 1
fi

echo "Baking API: $API_URL"
echo "Tag:        $TAG"

docker build \
  --build-context cli-src="$CLI" \
  --build-arg REVENANT_API_URL="$API_URL" \
  -t "$TAG" \
  -t "${TAG%:*}:latest" \
  "$ROOT"

echo
echo "Built. Login and push when ready:"
echo "  docker login"
echo "  docker push $TAG"
echo "  docker push ${TAG%:*}:latest"
echo
echo "Customer run (token only):"
echo "  docker run -d --restart unless-stopped \\"
echo "    -e REVENANT_RUNNER_TOKEN=rvn_... \\"
echo "    ${TAG%:*}:latest"
echo
echo "To change API later: rebuild with a new REVENANT_API_URL and push. Same tokens still work."
