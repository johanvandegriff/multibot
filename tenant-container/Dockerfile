FROM golang:1.23.5 AS builder
ARG CGO_ENABLED=0
WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download
COPY common/ common/
COPY tenant-container/ tenant-container/
RUN mv tenant-container/src/*.go .

RUN CGO_ENABLED=0 GOOS=linux go build -o server

FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
WORKDIR /app
COPY --from=builder /app/server .
COPY tenant-container/ .
EXPOSE 8080
ENTRYPOINT ["/app/server"]
