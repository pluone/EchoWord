#!/bin/bash
# 打包 Chrome 扩展为 zip，输出到 dist/ 目录
# 用法：bash package.sh  （或带版本号：bash package.sh 0.3.0）
set -euo pipefail

cd "$(dirname "$0")"

# 从 manifest 或第一个参数读取版本号
VERSION="${1:-$(node -e "console.log(require('./manifest.json').version)")}"

OUTDIR="dist"
OUTFILE="${OUTDIR}/EchoWord-${VERSION}.zip"

# 排除：打包脚本自身、git、文档、项目说明、Claude/编辑器配置、workbuddy、截图、DS_Store、dist 自身
EXCLUDE=(
  "package.sh"
  ".git"
  ".gitignore"
  "docs"
  "CLAUDE.md"
  ".claude"
  ".workbuddy"
  ".DS_Store"
  "dist"
  "dist_staging"
  "*.swp"
)

EXCLUDE_ARGS=()
for p in "${EXCLUDE[@]}"; do
  EXCLUDE_ARGS+=(--exclude "$p")
done

rm -rf dist_staging
mkdir -p dist_staging

# 拷贝需要打包的文件到暂存目录，规避 zip 记录 dist/dist_staging 自身路径
rsync -a --delete "${EXCLUDE_ARGS[@]}" ./ dist_staging/

mkdir -p "$OUTDIR"
rm -f "$OUTFILE"

(
  cd dist_staging
  zip -r -q "../$OUTFILE" .
)

rm -rf dist_staging

echo "已打包：$OUTFILE"
