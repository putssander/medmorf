#!/bin/sh
# Stamp a deploy copy of the app with one build id derived from the commit:
#   <commit date>-<short sha>   e.g. 2026-09-10-f8e518a
# It rewrites, inside the target directory only:
#   - window.MEDMORF_BUILD_ID in index.html   (shown in the page footer)
#   - CACHE_NAME in sw.js                      (fresh app-shell cache per deploy;
#                                               model-weight caches are untouched)
#   - every ?v=<tag> asset query string in index.html, sw.js and src/*.js
# So nobody has to bump versions by hand and every deploy busts the shell cache.
# Run it on a clean copy (GitHub Actions workflow, tools/deploy-pages.sh) —
# never on the working tree. Override with BUILD_ID=... if ever needed.
set -e
DIR="${1:-.}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SHA=$(git -C "$REPO" rev-parse --short=7 HEAD)
DATE=$(git -C "$REPO" log -1 --format=%cs HEAD)
BUILD_ID="${BUILD_ID:-$DATE-$SHA}"
case "$BUILD_ID" in *[!A-Za-z0-9._-]*) echo "invalid BUILD_ID: $BUILD_ID" >&2; exit 1;; esac

stamp() {
    f="$1"
    [ -f "$f" ] || return 0
    sed \
        -e "s/window\.MEDMORF_BUILD_ID = '[^']*'/window.MEDMORF_BUILD_ID = '$BUILD_ID'/" \
        -e "s/const CACHE_NAME = 'medmorf-app-[^']*'/const CACHE_NAME = 'medmorf-app-$BUILD_ID'/" \
        -e "s/?v=[A-Za-z0-9._-]\{1,\}/?v=$BUILD_ID/g" \
        "$f" > "$f.stamp.tmp" && mv "$f.stamp.tmp" "$f"
}

stamp "$DIR/index.html"
stamp "$DIR/sw.js"
for f in "$DIR"/src/*.js; do stamp "$f"; done

echo "stamped build id $BUILD_ID into $DIR"
grep -q "MEDMORF_BUILD_ID = '$BUILD_ID'" "$DIR/index.html" || { echo "stamp failed: index.html" >&2; exit 1; }
grep -q "CACHE_NAME = 'medmorf-app-$BUILD_ID'" "$DIR/sw.js" || { echo "stamp failed: sw.js" >&2; exit 1; }
