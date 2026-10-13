# revenant-agent

Self-hosted worker: claims jobs from Revenant Cloud and runs **`revenant verify`** (Go CLI).

## Local (no Docker)

```bash
cp agent.example.yaml agent.yaml
# paste token from Settings → Services → Issue agent token
npm install
REVENANT_RUNNER_TOKEN=rvn_... \
REVENANT_CLI_GITHUB_TOKEN=github_read_token npm start
```

The agent downloads the latest published Revenant CLI release from GitHub when it
starts; it does not use a CLI from PATH or a configured local file. If the CLI
repository is private, provide a GitHub token with read access through the
`REVENANT_CLI_GITHUB_TOKEN` environment variable. The token is used only for the
release download and is not passed to validation jobs.

Default control-plane URL for **local** images is **`http://127.0.0.1:8080`**.

## Docker

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
  -e REVENANT_CLI_GITHUB_TOKEN=github_read_token \
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

### Customers

```bash
docker run -d --restart unless-stopped \
  -e REVENANT_RUNNER_TOKEN=rvn_... \
  -e REVENANT_CLI_GITHUB_TOKEN=github_read_token \
  277pawan/revenant-agent:latest
```

Supply `REVENANT_CLI_GITHUB_TOKEN` from your deployment's secret manager; do
not bake it into the image or commit it. It must have read access to the
private `revenant-cli` repository's releases.

**Change API later:** rebuild + push a new image with a new `REVENANT_API_URL`. Same tokens. Customers `docker pull` the new tag. They still never type a URL.

Or Compose (local):

```bash
export REVENANT_RUNNER_TOKEN=rvn_...
export REVENANT_CLI_GITHUB_TOKEN=github_read_token
docker compose up --build
```
