# Triage Agent Demo Runtime

This folder contains two demo surfaces:

- A lightweight offline UI/API demo served by `npm start`.
- A Dockerized OpenCode runtime with a demo `triage-agent` served by the `Dockerfile`.

Rules:

- Keep offline demo diagnostics deterministic.
- Live Azure diagnostics are optional and must be read-only.
- Do not require Azure credentials, Microsoft Entra credentials, PostgreSQL, or live customer data for the basic demo.
- Do not print secrets or environment variables.
- Do not add destructive tools to the demo agent.
- Use the demo observability tool and seeded evidence when live Azure auth is unavailable.
- Use Azure CLI read-only commands only when the user explicitly configures Azure auth and asks for live diagnostics.
