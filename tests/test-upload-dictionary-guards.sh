#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cat >"$TMP/vp" <<'EOF'
#!/bin/sh
[ "${VP_FAIL:-0}" = 1 ] && exit 9
exit 0
EOF
cat >"$TMP/rclone" <<'EOF'
#!/bin/sh
touch "${RCLONE_SENTINEL:?}"
COUNT_FILE="${RCLONE_SENTINEL}.count"
ATTEMPT=$(cat "$COUNT_FILE" 2>/dev/null || echo 0); ATTEMPT=$((ATTEMPT + 1)); echo "$ATTEMPT" > "$COUNT_FILE"
if [ "${RCLONE_CLEAN:-0}" = 1 ] || { [ "${RCLONE_ALLOW_TEST:-0}" = 1 ] && [ "$ATTEMPT" -gt 1 ]; }; then exit 0; fi
echo "NOTICE: remote-only path with spaces.json: Skipped delete as --dry-run is set"
exit 0
EOF
chmod +x "$TMP/vp" "$TMP/rclone"
# Canonical failure must prevent any rclone invocation (sentinel remains absent).
if VP_FAIL=1 RCLONE_SENTINEL="$TMP/seen" PATH="$TMP:$PATH" RCLONE_CONFIG=/dev/null "$ROOT/commands/upload_dictionary.sh" </dev/null 2>/dev/null; then exit 1; fi
[ ! -e "$TMP/seen" ]
# CNS scope must also fail before its dry-run when canonical check fails.
if VP_FAIL=1 RCLONE_SENTINEL="$TMP/cns-seen" UPLOAD_SCOPE=cns PATH="$TMP:$PATH" RCLONE_CONFIG=/dev/null "$ROOT/commands/upload_dictionary.sh" </dev/null 2>/dev/null; then exit 1; fi
[ ! -e "$TMP/cns-seen" ]
ALLOW="$ROOT/data/sources/dictionary-deletion-allowlist.txt"
if RCLONE_SENTINEL="$TMP/reject-seen" PATH="$TMP:$PATH" RCLONE_CONFIG=/dev/null "$ROOT/commands/upload_dictionary.sh" </dev/null 2>/dev/null; then exit 1; fi
# An exact destination-qualified allowlisted deletion is accepted.
printf '%s\n' 'r2:moedict-dictionary-preview/pack/remote-only path with spaces.json' >>"$ALLOW"
trap 'sed -i.bak "/^r2:moedict-dictionary-preview\\/pack\\/remote-only path with spaces\\.json$/d" "$ALLOW"; rm -f "$ALLOW.bak"; rm -rf "$TMP"' EXIT
printf 'y\n' | RCLONE_ALLOW_TEST=1 RCLONE_SENTINEL="$TMP/allow-seen" PATH="$TMP:$PATH" RCLONE_CONFIG=/dev/null "$ROOT/commands/upload_dictionary.sh" >/dev/null 2>&1
[ -e "$TMP/allow-seen" ]
echo 'upload guard tests passed'
