# CI/CD Setup for Temporal Server

This directory contains the CI/CD configuration for building and deploying Temporal Server with visibility caching to AWS ECR.

## GitHub Actions Workflow

**File**: `.github/workflows/build-and-push.yml`

### Triggers

- **Push to any branch**: Builds test image
- **Push tag**: Builds production image

### Environments

| Environment | Trigger | AWS Region | ECR Registry |
|-------------|---------|------------|--------------|
| **test** | Push to branch | ap-south-1 | Test ECR |
| **production** | Push tag (e.g., v1.0.0) | us-east-1 | Production ECR |

### Image Tags

Images are tagged with:
- **Branch builds**: `test-<branch>-<sha>-<date>` (e.g., `test-main-a5af156-20260609`)
- **Tag builds**: `<version>` (e.g., `v1.25.0-cache`)
- **Latest**: `latest` (for main branch)

### Secrets Required

Configure these in GitHub repository settings:

**Production (us-east-1):**
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

**Test (ap-south-1):**
- `AWS_HEADOUT_TEST_ACCESS_KEY`
- `AWS_HEADOUT_TEST_SECRET_KEY`

## Build Process

1. **Checkout code**
2. **Setup Go 1.23**
3. **Build binary**: `make temporal-server`
4. **Setup Docker Buildx**
5. **Configure AWS credentials** (based on environment)
6. **Login to ECR**
7. **Build and push Docker image**

## Docker Image

**Base**: Alpine Linux 3.19  
**Size**: ~50-100MB  
**User**: Non-root (temporal:1000)  
**Binary**: Pre-built in GitHub Actions

### Exposed Ports

- 7233 - Frontend gRPC
- 7234 - History gRPC
- 7235 - Matching gRPC
- 7239 - Worker gRPC
- 6933-6939 - Membership ports

## Deployment

### Test Environment

```bash
# Automatically triggered on push to any branch
git push origin ft/visibility-caching

# Image will be available at:
# <test-ecr-registry>/container-images/temporal-server:test-ft/visibility-caching-<sha>-<date>
```

### Production Environment

```bash
# Create and push a tag
git tag v1.25.0-cache
git push origin v1.25.0-cache

# Image will be available at:
# <prod-ecr-registry>/container-images/temporal-server:v1.25.0-cache
```

## Using the Image

### Kubernetes/Helm

```yaml
server:
  image:
    repository: <ecr-registry>/container-images/temporal-server
    tag: v1.25.0-cache
    pullPolicy: IfNotPresent
```

### Docker

```bash
# Pull from ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin <ecr-registry>

docker pull <ecr-registry>/container-images/temporal-server:v1.25.0-cache

# Run
docker run -d \
  --name temporal \
  -p 7233:7233 \
  <ecr-registry>/container-images/temporal-server:v1.25.0-cache
```

## Monitoring Build Status

Check GitHub Actions:
- Go to repository → Actions tab
- Look for "Build and Push" workflow
- View logs for each step

## Troubleshooting

### Build Fails

1. Check GitHub Actions logs
2. Verify Go version compatibility
3. Ensure `make temporal-server` works locally

### Push to ECR Fails

1. Verify AWS credentials are configured
2. Check ECR repository exists: `container-images/temporal-server`
3. Verify IAM permissions for ECR push

### Image Not Found

1. Check ECR console for the image
2. Verify tag format matches expected pattern
3. Ensure workflow completed successfully

## Local Testing

To test the Dockerfile locally:

```bash
# Build the binary
make temporal-server

# Build the Docker image
docker build -f ci/Dockerfile -t temporal-server:local .

# Run
docker run --rm temporal-server:local --version
```

## Configuration

The image includes default configuration from `/config` directory.

To use custom configuration:

```bash
docker run -d \
  -v $(pwd)/my-config.yaml:/etc/temporal/config/development.yaml \
  <ecr-registry>/container-images/temporal-server:v1.25.0-cache \
  start --config /etc/temporal/config/development.yaml
```

## Visibility Caching

The image includes visibility caching support. Enable it in your config:

```yaml
persistence:
  datastores:
    postgres-visibility:
      sql:
        visibilityCache:
          enabled: true
          cacheTTLSeconds: 20
```

See `docs/visibility-cache-config-example.yaml` for full configuration.
