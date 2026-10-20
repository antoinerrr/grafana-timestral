FROM node:22-bookworm-slim AS plugin
WORKDIR /plugin
COPY plugin/package*.json plugin/.npmrc ./
RUN npm ci
COPY plugin/ ./
RUN npm run build

FROM grafana/grafana:13.0.2
COPY --from=plugin /plugin/dist /opt/grafana/plugins/antoinerrr-timestral-datasource
COPY demo/provisioning /etc/grafana/provisioning
COPY demo/timestral.json /etc/grafana/dashboards/timestral.json
