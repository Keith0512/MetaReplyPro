#!/bin/zsh
# MetaReplyPro macOS Native Messaging host。
# stdout 只能輸出 Chrome Native Messaging 的框架內容。

set -u

SCRIPT_DIR="${0:A:h}"
MAX_MESSAGE_SIZE=$((1024 * 1024))

send_message() {
  local json="$1"
  local length byte shift
  length="$(LC_ALL=C print -rn -- "$json" | /usr/bin/wc -c | /usr/bin/tr -d ' ')"
  for shift in 0 8 16 24; do
    byte=$(( (length >> shift) & 255 ))
    printf "\\$(printf '%03o' "$byte")"
  done
  print -rn -- "$json"
}

read_version() {
  local version
  version="$(/usr/bin/plutil -extract version raw -o - \
    "$SCRIPT_DIR/chrome-extension/manifest.json" 2>/dev/null)" || return 1
  [[ "$version" =~ '^[0-9]+(\.[0-9]+){2,3}$' ]] || return 1
  print -rn -- "$version"
}

header="$(/bin/dd bs=4 count=1 2>/dev/null | /usr/bin/od -An -tu4 | /usr/bin/tr -d ' ')"
if [[ -z "$header" || "$header" != <-> || "$header" -le 0 || "$header" -gt "$MAX_MESSAGE_SIZE" ]]; then
  send_message '{"ok":false,"message":"Native Messaging 訊息格式無效"}'
  exit 0
fi

payload="$(/bin/dd bs=1 count="$header" 2>/dev/null)"
payload_size="$(LC_ALL=C print -rn -- "$payload" | /usr/bin/wc -c | /usr/bin/tr -d ' ')"
if [[ "$payload_size" -ne "$header" ]]; then
  send_message '{"ok":false,"message":"Native Messaging 訊息內容不完整"}'
  exit 0
fi

action="$(print -rn -- "$payload" | /usr/bin/plutil -extract action raw -o - - 2>/dev/null)"
if [[ "$action" != 'update' ]]; then
  send_message '{"ok":false,"message":"不支援的更新動作"}'
  exit 0
fi

before="$(read_version || true)"
if /bin/zsh "$SCRIPT_DIR/update-macos.sh" >/dev/null 2>>"$SCRIPT_DIR/update.log"; then
  after="$(read_version || true)"
  if [[ "$before" != "$after" ]]; then
    send_message "{\"ok\":true,\"updated\":true,\"before\":\"$before\",\"after\":\"$after\"}"
  else
    send_message "{\"ok\":true,\"updated\":false,\"before\":\"$before\",\"after\":\"$after\"}"
  fi
else
  after="$(read_version || true)"
  send_message "{\"ok\":false,\"message\":\"更新失敗（release 不可用、簽章無效或網路問題）\",\"before\":\"$before\",\"after\":\"$after\"}"
fi
