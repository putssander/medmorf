#!/bin/sh
# Deploy the current git HEAD to Cloudflare Pages (project: medmorf).
# Uses a clean `git archive` so untracked/local files never leak into a deploy.
set -e
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git archive HEAD | tar -x -C "$TMP"
npx --yes wrangler pages deploy "$TMP" --project-name medmorf --branch main --commit-dirty=false
