FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg python3 bash \
    && mkdir -p /etc/apt/keyrings \
    && curl -sLS https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor > /etc/apt/keyrings/microsoft.gpg \
    && chmod go+r /etc/apt/keyrings/microsoft.gpg \
    && AZ_REPO="$(. /etc/os-release && printf '%s' "$VERSION_CODENAME")" \
    && printf 'deb [arch=%s signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ %s main\n' "$(dpkg --print-architecture)" "$AZ_REPO" > /etc/apt/sources.list.d/azure-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends azure-cli \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g opencode-ai @ai-sdk/openai-compatible

ENV HOME=/home/opencode \
    OPENCODE_HOSTNAME=0.0.0.0 \
    OPENCODE_PORT=4096 \
    OPENCODE_SERVER_USERNAME=opencode \
    OPENCODE_PROVIDER_ID=openai \
    OPENCODE_PROVIDER_NAME=OpenAI \
    OPENCODE_MODEL=gpt-4o-mini \
    OPENCODE_MODEL_DISPLAY_NAME="GPT-4o Mini" \
    OPENCODE_DEFAULT_AGENT=triage-agent \
    AZURE_LOGIN_WITH_MANAGED_IDENTITY=false \
    OPENAI_BASE_URL=https://api.openai.com/v1

WORKDIR /workspace

COPY ./entrypoint.sh /usr/local/bin/triage-agent-demo-entrypoint
COPY ./agents /workspace/.opencode/agent
COPY ./skills /workspace/.opencode/skills
COPY ./skills /workspace/skills
COPY ./tools /workspace/tools
COPY ./config /workspace/config
COPY ./AGENTS.md /workspace/AGENTS.md

RUN chmod +x /usr/local/bin/triage-agent-demo-entrypoint /workspace/tools/demo-observability.py \
    && mkdir -p /home/opencode/.config/opencode /home/opencode/.local/share/opencode /workspace/jobs \
    && chown -R node:node /home/opencode /workspace

USER node

EXPOSE 4096

ENTRYPOINT ["triage-agent-demo-entrypoint"]
