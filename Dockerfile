# kyc-reviewer-console — internal reviewer console (saas-core ADR-0021)
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
RUN CGO_ENABLED=0 go build -o /out/console ./cmd/server

FROM alpine:3.20
RUN adduser -D -H console
USER console
WORKDIR /app
COPY --from=build /out/console ./console
COPY web/ ./web/
EXPOSE 8090
# INTERNAL_SERVICE_TOKEN must be provided by the orchestrator; the process
# fails fast without it (empty-secret guard).
ENTRYPOINT ["./console"]
