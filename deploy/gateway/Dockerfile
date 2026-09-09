# syntax=docker/dockerfile:1.7

ARG WORKER_IMAGE=pe-workbench-worker:local

FROM docker:26-cli AS docker-cli
FROM ${WORKER_IMAGE} AS gateway

USER root

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

ENV HOME=/var/lib/pe-workbench/gateway \
    PE_MULTI_USER_MODE=1 \
    PE_RUNTIME_ROLE=gateway

RUN mkdir -p /var/lib/pe-workbench/gateway /srv/pe-workbench/users

EXPOSE 30141

CMD ["npm", "run", "start:lan"]
