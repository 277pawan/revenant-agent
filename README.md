# revenant-agent

Local:

```bash
cp agent.example.yaml agent.yaml
# paste token from Settings → Validation services → Issue agent token
npm install
REVENANT_RUNNER_TOKEN=rvn_... npm start
```

Docker (API URL is baked into the image at build time):

```bash
docker run -d --restart unless-stopped \
  -e REVENANT_RUNNER_TOKEN=rvn_... \
  yourorg/revenant-agent:latest
```

Build image with your deployed API:

```bash
docker build --build-arg REVENANT_API_URL=https://api.yourdomain.com -t yourorg/revenant-agent .
```
