FROM node:22-alpine
WORKDIR /app
COPY services/api ./services/api
COPY services/runtime/lib ./services/runtime/lib
RUN mkdir /data && chown node:node /data
USER node
ENV PORT=8088 TRIAGE_DATA_DIR=/data
EXPOSE 8088
CMD ["node", "services/api/server.mjs"]
