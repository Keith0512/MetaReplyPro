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

header="$(/bin/dd bs=1 count=4 2>/dev/null | /usr/bin/od -An -tu4 | /usr/bin/tr -d ' ')"
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

message_field() {
  print -rn -- "$payload" | /usr/bin/plutil -extract "$1" raw -expect string -o - - 2>/dev/null
}

action="$(message_field action)"
if [[ "$action" != 'preview' && "$action" != 'update' ]]; then
  send_message '{"ok":false,"message":"不支援的更新動作"}'
  exit 0
fi

requested_version="$(message_field version)"
if [[ ! "$requested_version" =~ '^[0-9]+(\.[0-9]+){2,3}$' ]]; then
  send_message '{"ok":false,"message":"更新請求缺少有效版本"}'
  exit 0
fi

updater_args=(--install-dir "$SCRIPT_DIR" --expected-version "$requested_version")
if [[ "$action" == 'preview' ]]; then
  if preview="$(/bin/zsh "$SCRIPT_DIR/update-macos-pinned.sh" "${updater_args[@]}" --preview 2>>"$SCRIPT_DIR/update.log")"; then
    send_message "$preview"
  else
    send_message '{"ok":false,"message":"無法驗證該版本的發布資料"}'
  fi
  exit 0
fi

manifest_sha256="$(message_field manifestSha256)"
if [[ ! "$manifest_sha256" =~ '^[0-9a-f]{64}$' ]]; then
  send_message '{"ok":false,"message":"更新請求缺少已確認的發布資料 SHA-256"}'
  exit 0
fi

before="$(read_version || true)"
if /bin/zsh "$SCRIPT_DIR/update-macos-pinned.sh" "${updater_args[@]}" \
  --expected-manifest-sha256 "$manifest_sha256" >/dev/null 2>>"$SCRIPT_DIR/update.log"; then
  after="$(read_version || true)"
  if [[ "$before" != "$after" ]]; then
    send_message "{\"ok\":true,\"updated\":true,\"before\":\"$before\",\"after\":\"$after\"}"
  else
    send_message "{\"ok\":true,\"updated\":false,\"before\":\"$before\",\"after\":\"$after\"}"
  fi
else
  after="$(read_version || true)"
  send_message "{\"ok\":false,\"message\":\"無法驗證或安裝已確認的發布版本\",\"before\":\"$before\",\"after\":\"$after\"}"
fi
