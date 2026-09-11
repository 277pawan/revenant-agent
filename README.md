# Revenant Agent Box

Separate app from **Revenant Cloud**. This is the worker that runs on a customer machine (or CI).

It is **not** an npm package you import into the website. It is a **Node service** you start once and leave running.

```
revenant-cloud      → API + control plane
revenant-cloud-web → dashboard
revenant-agent     → Agent Box (this repo)  ← executes jobs
revenant-cli       → `revenant verify` engine (spawned by Agent Box)
```

## How it works

1. Admin opens Cloud → **Settings → Agent Box** → Connect worker → copies token  
2. On a server: put token in `agent.yaml` → `npm start`  
3. Users in the website only click **Run**  
4. Agent Box polls Cloud, claims the job, runs `revenant verify`, posts results  

## Setup

```bash
cd revenant-agent
cp agent.example.yaml agent.yaml
# edit apiUrl + token from Settings
npm install
npm start
```

Optional: set `cliPath` (or `REVENANT_CLI_PATH`) to your `revenant` binary.

## Later

- Publish as Docker image / binary so customers never need this source tree  
- systemd unit for always-on install  
- Optional public npm CLI: `npx revenant-agent` (same process, nicer packaging)
