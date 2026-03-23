#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/release.sh <version>
# Example: ./scripts/release.sh 0.4.0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# --- Helpers ---
die() { echo "error: $1" >&2; exit 1; }
info() { echo "==> $1"; }

# --- Input validation ---
NEW="${1:-}"
[ -z "$NEW" ] && die "usage: $0 <version>  (e.g. $0 0.4.0)"
[[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid semver: $NEW (expected X.Y.Z)"

OLD=$(node -p "require('./package.json').version")
[ "$OLD" = "$NEW" ] && die "version is already $NEW"

# --- Pre-flight checks ---
[ -n "$(git status --porcelain)" ] && die "working tree is dirty — commit or stash first"
git rev-parse "v${NEW}" >/dev/null 2>&1 && die "tag v${NEW} already exists"

TODAY=$(date +%Y-%m-%d)
info "Bumping $OLD → $NEW (${TODAY})"

# --- 1. package.json ---
info "Updating package.json"
sed -i "s/\"version\": \"${OLD}\"/\"version\": \"${NEW}\"/" package.json

# --- 2. CHANGELOG.md ---
info "Updating CHANGELOG.md"
# Insert new version header after ## [Unreleased] blank line
sed -i "/^## \[Unreleased\]$/a\\\\n## [${NEW}] - ${TODAY}" CHANGELOG.md
# Update [Unreleased] compare link
sed -i "s|compare/v${OLD}\.\.\.HEAD|compare/v${NEW}...HEAD|" CHANGELOG.md
# Insert new version compare link after [Unreleased] link line
sed -i "/^\[Unreleased\]:/a [${NEW}]: https://github.com/littlebearapps/cf-monitor/compare/v${OLD}...v${NEW}" CHANGELOG.md

# --- 3. CLAUDE.md (status line only) ---
info "Updating CLAUDE.md"
sed -i "s/| \*\*Status\*\* | v${OLD}/| **Status** | v${NEW}/" CLAUDE.md

# --- 4. Bug report template ---
info "Updating bug_report.yml"
sed -i "s/placeholder: \"${OLD}\"/placeholder: \"${NEW}\"/" .github/ISSUE_TEMPLATE/bug_report.yml

# --- 5. llms.txt ---
info "Updating llms.txt"
sed -i "s/v0\.1\.0 to v${OLD}/v0.1.0 to v${NEW}/" llms.txt

# --- 6. docs/README.md ---
info "Updating docs/README.md"
sed -i "s/v0\.1\.0 to v${OLD}/v0.1.0 to v${NEW}/" docs/README.md

# --- Verify no stale references ---
info "Checking for remaining references to ${OLD}..."
STALE=$(grep -rn "${OLD}" --include="*.json" --include="*.md" --include="*.yml" --include="*.txt" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  | grep -v "CHANGELOG.md" | grep -v "package-lock.json" || true)
if [ -n "$STALE" ]; then
  echo "warning: old version ${OLD} still found in:"
  echo "$STALE"
  echo "(These may be intentional — e.g. historical docs. Review before pushing.)"
fi

# --- Commit, tag, push ---
info "Committing and tagging"
git add package.json CHANGELOG.md CLAUDE.md .github/ISSUE_TEMPLATE/bug_report.yml llms.txt docs/README.md
git commit -m "chore: release v${NEW}"
git tag "v${NEW}"

info "Pushing to origin"
git push origin main
git push origin "v${NEW}"

info "Done! v${NEW} tagged and pushed."
info "GitHub Actions will now: run tests → publish to npm → create GitHub Release"
