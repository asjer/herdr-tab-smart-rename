#!/bin/sh
set -eu

# Herdr plugin actions run in a clean environment. When a model-backed action
# is invoked from the command palette, re-enter through the private 1Password
# wrapper so the API key is available only to this process tree.
command_name="${2:-}"
ai_enabled="${SMART_RENAME_AI_ENABLED:-}"
if [ -z "$ai_enabled" ] && [ -n "${HERDR_PLUGIN_CONFIG_DIR:-}" ]; then
  provider_file="$HERDR_PLUGIN_CONFIG_DIR/provider.env"
  if [ -f "$provider_file" ] && grep -Eiq '^[[:space:]]*SMART_RENAME_AI_ENABLED[[:space:]]*=[[:space:]]*(1|true)[[:space:]]*$' "$provider_file"; then
    ai_enabled=1
    export SMART_RENAME_AI_ENABLED=1
  fi
fi
case "$ai_enabled" in
  1|[Tt][Rr][Uu][Ee])
    ai_enabled=1
    export SMART_RENAME_AI_ENABLED=1
    ;;
esac

case "$command_name:$ai_enabled" in
  start:1|check-ai:1|rename-now:1|all:1|reset-tab:1|reset-workspace:1)
    if [ -z "${SMART_RENAME_API_KEY:-}" ] && [ -n "${HERDR_PLUGIN_CONFIG_DIR:-}" ]; then
      secret_wrapper="$HERDR_PLUGIN_CONFIG_DIR/run-with-1password.sh"
      if [ -x "$secret_wrapper" ]; then
        exec "$secret_wrapper" "$command_name"
      fi
    fi
    ;;
esac

bun_path=$(command -v bun 2>/dev/null || true)
if [ -n "$bun_path" ] && [ -x "$bun_path" ]; then
  exec "$bun_path" "$@"
fi

if [ -n "${HOME:-}" ] && [ -x "$HOME/.bun/bin/bun" ]; then
  exec "$HOME/.bun/bin/bun" "$@"
fi

for bun_path in /opt/homebrew/bin/bun /usr/local/bin/bun /home/linuxbrew/.linuxbrew/bin/bun; do
  if [ -x "$bun_path" ]; then
    exec "$bun_path" "$@"
  fi
done

printf '%s\n' 'Smart Rename: Bun not found; install Bun or add it to the Herdr server PATH' >&2
exit 127
