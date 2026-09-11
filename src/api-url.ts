/** Baked at Docker build time. Override locally via agent.yaml apiUrl or REVENANT_API_URL. */
export const DEFAULT_API_URL =
  process.env.REVENANT_API_URL?.replace(/\/$/, "") ??
  "http://127.0.0.1:8080";
