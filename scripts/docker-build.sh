# ============================================================
# Docker 镜像构建 & 推送方案
# ============================================================
#
# 用法:
#   bash scripts/docker-build.sh          # 构建本地镜像
#   bash scripts/docker-build.sh --push   # 构建并推送到仓库
#   bash scripts/docker-build.sh --multi  # 多架构构建 (amd64 + arm64)
#
# ============================================================

set -euo pipefail

# -------- 配置 --------
IMAGE_NAME="${IMAGE_NAME:-qa-for-code}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
REGISTRY="${REGISTRY:-}"  # 留空 = 本地，例如 docker.io/myuser/

# Claude Code 版本（与 Dockerfile 中保持一致）
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-2.1.179}"

# -------- 参数解析 --------
PUSH=false
MULTI_ARCH=false

for arg in "$@"; do
  case "$arg" in
    --push)   PUSH=true ;;
    --multi)  MULTI_ARCH=true ;;
    --tag=*)  IMAGE_TAG="${arg#*=}" ;;
    *)        echo "未知参数: $arg"; exit 1 ;;
  esac
done

FULL_IMAGE="${REGISTRY}${IMAGE_NAME}:${IMAGE_TAG}"

echo "=========================================="
echo " Code QA Service — Docker Build"
echo "=========================================="
echo " Image:     $FULL_IMAGE"
echo " Claude:    v$CLAUDE_CODE_VERSION"
echo " Multi-arch: $MULTI_ARCH"
echo " Push:      $PUSH"
echo "=========================================="

# -------- 构建 --------
if [ "$MULTI_ARCH" = true ]; then
  # 多架构构建（需要 buildx）
  echo ""
  echo "[1/3] 设置 buildx builder..."
  docker buildx create --use --name qa-builder 2>/dev/null || docker buildx use qa-builder

  echo "[2/3] 构建多架构镜像 (linux/amd64, linux/arm64)..."
  docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --build-arg CLAUDE_CODE_VERSION="$CLAUDE_CODE_VERSION" \
    -t "$FULL_IMAGE" \
    $([ "$PUSH" = true ] && echo "--push" || echo "--load") \
    .

else
  # 单架构构建（显式 linux/amd64，因为容器内是 Linux）
  echo ""
  echo "[1/2] 构建镜像 (linux/amd64)..."
  docker build \
    --platform linux/amd64 \
    --build-arg CLAUDE_CODE_VERSION="$CLAUDE_CODE_VERSION" \
    -t "$FULL_IMAGE" \
    .

  # -------- 推送 --------
  if [ "$PUSH" = true ]; then
    echo ""
    echo "[2/2] 推送镜像..."
    docker push "$FULL_IMAGE"
  fi
fi

echo ""
echo "=========================================="
echo " ✓ 构建完成"
echo "=========================================="
echo ""
echo " 镜像: $FULL_IMAGE"
echo ""
echo " 本地运行:"
echo "   docker run -d -p 3100:3100 \\"
echo "     -e ANTHROPIC_API_KEY=sk-ant-xxx \\"
echo "     -v \$(pwd)/src-repo:/src-repo:ro \\"
echo "     $FULL_IMAGE"
echo ""
echo " 或使用 docker compose:"
echo "   docker compose up -d"
echo ""
