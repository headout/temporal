# Dockerfile for Temporal Server with Visibility Caching
# Uses pre-built binary from GitHub Actions

FROM alpine:3.19

ARG APP_ENV=test

# Install runtime dependencies
RUN apk add --no-cache \
    ca-certificates \
    tzdata \
    bash

# Create temporal user and group
RUN addgroup -g 1000 temporal && \
    adduser -u 1000 -G temporal -s /bin/sh -D temporal

# Set working directory
WORKDIR /etc/temporal

# Copy the pre-built binary from GitHub Actions build step
COPY temporal-server /usr/local/bin/temporal-server

# Copy default config
COPY config /etc/temporal/config

# Create directories for temporal
RUN mkdir -p /etc/temporal/config /var/log/temporal && \
    chown -R temporal:temporal /etc/temporal /var/log/temporal

# Switch to temporal user
USER temporal

# Expose ports
# 7233 - Frontend gRPC
# 7234 - History gRPC
# 7235 - Matching gRPC
# 7239 - Worker gRPC
# 6933 - Frontend membership
# 6934 - History membership
# 6935 - Matching membership
# 6939 - Worker membership
EXPOSE 7233 7234 7235 7239 6933 6934 6935 6939

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["/usr/local/bin/temporal-server", "--version"]

# Default entrypoint
ENTRYPOINT ["/usr/local/bin/temporal-server"]

# Default command
CMD ["start"]
