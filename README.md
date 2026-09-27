# revenant-agent

Self-hosted worker: claims jobs from Revenant Cloud and runs **`revenant verify`** (Go CLI).

## Local (no Docker)

```bash
cp agent.example.yaml agent.yaml
# paste token from Settings → Services → Issue agent token
npm install
REVENANT_RUNNER_TOKEN=rvn_... npm start
```

Requires `revenant` on PATH (build CLI: `cd ../revenant-cli && go build -o revenant .`).

Default control-plane URL for **local** images is **`http://127.0.0.1:8080`**.

## Docker (Phase 5 — CLI baked in)

```bash
sudo usermod -aG docker "$USER"
newgrp docker
```

**`revenant-agent:local`** = name `revenant-agent`, tag `local` (your laptop, not Hub).

```bash
cd revenant-agent
./scripts/build-agent-image.sh
```

### This laptop (API still localhost)

`localhost` inside Docker is the container. `--add-host` is **only for you**:

```bash
docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -e REVENANT_API_URL=http://host.docker.internal:8080 \
  -e REVENANT_RUNNER_TOKEN=rvn_... \
  revenant-agent:local
```

### Publish (you bake the real API — customers never see it)

```bash
REVENANT_API_URL=https://api.yourdomain.com \
  ./scripts/publish-agent-image.sh 277pawan/revenant-agent:0.1.0
docker login
docker push 277pawan/revenant-agent:0.1.0
docker push 277pawan/revenant-agent:latest
```

Set web `VITE_AGENT_IMAGE=277pawan/revenant-agent:latest` so Services copies the right pull name.

### Customers (token only)

```bash
docker run -d --restart unless-stopped \
  -e REVENANT_RUNNER_TOKEN=rvn_... \
  277pawan/revenant-agent:latest
```

**Change API later:** rebuild + push a new image with a new `REVENANT_API_URL`. Same tokens. Customers `docker pull` the new tag. They still never type a URL.

Or Compose (local):

```bash
export REVENANT_RUNNER_TOKEN=rvn_...
docker compose up --build
```
