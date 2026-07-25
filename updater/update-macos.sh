#!/bin/zsh
# MetaReplyPro macOS 安全更新器。
# 只接受固定公開金鑰簽署的 release manifest，並在替換前核對 ZIP 的 SHA-256。

set -u
setopt pipefail

INSTALL_DIR="$HOME/Library/Application Support/MetaReplyPro"
MANIFEST_SOURCE='https://github.com/Keith0512/MetaReplyPro/releases/latest/download/update-manifest.json'
SIGNATURE_SOURCE='https://github.com/Keith0512/MetaReplyPro/releases/latest/download/update-manifest.json.sig'
PUBLIC_KEY_PATH=''
ALLOW_LOCAL_SOURCES=0
TEMP_DIR=''

log() {
  local message="$1"
  /bin/mkdir -p "$INSTALL_DIR" 2>/dev/null || true
  print -r -- "$(/bin/date '+%Y-%m-%d %H:%M:%S')  $message" >> "$INSTALL_DIR/update.log"
}

fail() {
  log "更新失敗並已拒絕套用：$1"
  print -u2 -- "更新失敗：$1"
  return 1
}

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    /bin/rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT INT TERM

json_value() {
  /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null
}

assert_release_url() {
  local url="$1"
  local name="$2"
  [[ "$url" =~ '^https://github\.com/Keith0512/MetaReplyPro/releases/(latest/download|download/[^/]+)/[^/?#]+$' ]] ||
    fail "$name 必須是 Keith0512/MetaReplyPro 的 HTTPS release asset"
}

get_trusted_file() {
  local source="$1"
  local destination="$2"
  local name="$3"
  if [[ "$source" == https://* ]]; then
    assert_release_url "$source" "$name" || return 1
    /usr/bin/curl --fail --silent --show-error --location \
      --proto '=https' --proto-redir '=https' --tlsv1.2 \
      --output "$destination" "$source" ||
      fail "無法下載$name"
  elif (( ALLOW_LOCAL_SOURCES == 1 )); then
    /bin/cp "$source" "$destination" ||
      fail "無法讀取本機$name"
  else
    fail "$name 拒絕非 HTTPS 來源"
  fi
}

version_is_newer() {
  /usr/bin/awk -v remote="$1" -v local_version="$2" '
    BEGIN {
      split(remote, r, ".");
      split(local_version, l, ".");
      for (i = 1; i <= 4; i++) {
        rv = (r[i] == "" ? 0 : r[i]) + 0;
        lv = (l[i] == "" ? 0 : l[i]) + 0;
        if (rv > lv) exit 0;
        if (rv < lv) exit 1;
      }
      exit 1;
    }
  '
}

while (( $# > 0 )); do
  case "$1" in
    --install-dir)
      (( $# >= 2 )) || { print -u2 -- '--install-dir 缺少路徑'; exit 1; }
      INSTALL_DIR="${2:A}"
      shift 2
      ;;
    --manifest)
      (( $# >= 2 )) || { print -u2 -- '--manifest 缺少來源'; exit 1; }
      MANIFEST_SOURCE="$2"
      shift 2
      ;;
    --signature)
      (( $# >= 2 )) || { print -u2 -- '--signature 缺少來源'; exit 1; }
      SIGNATURE_SOURCE="$2"
      shift 2
      ;;
    --public-key)
      (( $# >= 2 )) || { print -u2 -- '--public-key 缺少路徑'; exit 1; }
      PUBLIC_KEY_PATH="${2:A}"
      shift 2
      ;;
    --allow-local-sources)
      ALLOW_LOCAL_SOURCES=1
      shift
      ;;
    *)
      print -u2 -- "不支援的參數：$1"
      exit 1
      ;;
  esac
done

[[ -d "$INSTALL_DIR" ]] || { print -u2 -- '找不到安裝目錄，請先安裝 MetaReplyPro'; exit 1; }
[[ -n "$PUBLIC_KEY_PATH" ]] || PUBLIC_KEY_PATH="$INSTALL_DIR/trusted-update-key.pem"
[[ -f "$PUBLIC_KEY_PATH" ]] || { fail "找不到受信任的更新公開金鑰：$PUBLIC_KEY_PATH"; exit 1; }

extension_dir="$INSTALL_DIR/chrome-extension"
local_manifest="$extension_dir/manifest.json"
[[ -f "$local_manifest" ]] || { fail '本機擴充功能缺少 manifest.json，請重新安裝'; exit 1; }
local_version="$(json_value "$local_manifest" version)" ||
  { fail '本機擴充功能版本無效'; exit 1; }
[[ "$local_version" =~ '^[0-9]+(\.[0-9]+){2,3}$' ]] ||
  { fail '本機擴充功能版本無效'; exit 1; }

TEMP_DIR="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/MetaReplyProUpdate.XXXXXXXX")" ||
  { fail '無法建立暫存目錄'; exit 1; }
remote_manifest="$TEMP_DIR/update-manifest.json"
remote_signature="$TEMP_DIR/update-manifest.json.sig"
signature_binary="$TEMP_DIR/update-manifest.sig.bin"

get_trusted_file "$MANIFEST_SOURCE" "$remote_manifest" ' release manifest' || exit 1
get_trusted_file "$SIGNATURE_SOURCE" "$remote_signature" ' release manifest 簽章' || exit 1

if ! /usr/bin/base64 -D -i "$remote_signature" -o "$signature_binary" 2>/dev/null; then
  fail 'release manifest 簽章不是有效的 Base64'
  exit 1
fi
if ! /usr/bin/openssl dgst -sha256 -verify "$PUBLIC_KEY_PATH" \
  -signature "$signature_binary" "$remote_manifest" >/dev/null 2>&1; then
  fail 'release manifest 簽章驗證失敗'
  exit 1
fi

release_schema="$(json_value "$remote_manifest" schemaVersion)" ||
  { fail 'release manifest 格式無效'; exit 1; }
release_key_id="$(json_value "$remote_manifest" keyId)" ||
  { fail 'release manifest 缺少 keyId'; exit 1; }
release_version="$(json_value "$remote_manifest" version)" ||
  { fail 'release manifest 缺少版本'; exit 1; }
release_commit="$(json_value "$remote_manifest" commit)" ||
  { fail 'release manifest 缺少 commit'; exit 1; }
asset_name="$(json_value "$remote_manifest" assetName)" ||
  { fail 'release manifest 缺少 assetName'; exit 1; }
asset_source="$(json_value "$remote_manifest" assetUrl)" ||
  { fail 'release manifest 缺少 assetUrl'; exit 1; }
asset_sha256="$(json_value "$remote_manifest" assetSha256)" ||
  { fail 'release manifest 缺少 SHA-256'; exit 1; }

trusted_key_json="$INSTALL_DIR/trusted-update-key.json"
[[ -f "$trusted_key_json" ]] ||
  { fail '找不到受信任的更新金鑰識別資料'; exit 1; }
trusted_schema="$(json_value "$trusted_key_json" schemaVersion)" ||
  { fail '受信任的更新金鑰格式無效'; exit 1; }
trusted_algorithm="$(json_value "$trusted_key_json" algorithm)" ||
  { fail '受信任的更新金鑰格式無效'; exit 1; }
trusted_key_id="$(json_value "$trusted_key_json" keyId)" ||
  { fail '受信任的更新金鑰格式無效'; exit 1; }

[[ "$release_schema" == '1' ]] ||
  { fail '不支援的 release manifest 格式'; exit 1; }
[[ "$trusted_schema" == '1' && "$trusted_algorithm" == 'RSASSA-PKCS1-v1_5-SHA256' ]] ||
  { fail '受信任的更新金鑰格式無效'; exit 1; }
[[ "$release_key_id" == "$trusted_key_id" ]] ||
  { fail 'release manifest 的簽章金鑰識別碼不符'; exit 1; }
[[ "$release_version" =~ '^[0-9]+(\.[0-9]+){2,3}$' ]] ||
  { fail 'release manifest 的版本號無效'; exit 1; }
[[ "$release_commit" =~ '^[0-9a-f]{40}$' ]] ||
  { fail 'release manifest 的 commit SHA 無效'; exit 1; }
[[ "$asset_sha256" =~ '^[0-9a-f]{64}$' ]] ||
  { fail 'release manifest 的 SHA-256 無效'; exit 1; }
[[ "$asset_name" == "MetaReplyPro-v$release_version.zip" ]] ||
  { fail 'release manifest 的 assetName 與版本不一致'; exit 1; }

if [[ "$asset_source" == https://* ]]; then
  assert_release_url "$asset_source" 'release asset' || exit 1
elif (( ALLOW_LOCAL_SOURCES != 1 )); then
  fail 'release asset 拒絕非 HTTPS 來源'
  exit 1
fi
[[ "${asset_source:t}" == "$asset_name" ]] ||
  { fail 'release manifest 的 assetName 與 assetUrl 不一致'; exit 1; }

if ! version_is_newer "$release_version" "$local_version"; then
  log "已是最新版 $local_version（已驗證 release $release_version），不需更新"
  exit 0
fi

log "已驗證新版 manifest $release_version（本機 $local_version），開始下載固定 release"
zip_path="$TEMP_DIR/$asset_name"
get_trusted_file "$asset_source" "$zip_path" ' release asset' || exit 1
actual_sha256="$(/usr/bin/shasum -a 256 "$zip_path" | /usr/bin/awk '{print $1}')" ||
  { fail '無法計算 release asset SHA-256'; exit 1; }
[[ "$actual_sha256" == "$asset_sha256" ]] ||
  { fail "release asset SHA-256 不符（預期 $asset_sha256，實際 $actual_sha256）"; exit 1; }

root_name="MetaReplyPro-v$release_version"
zip_listing="$TEMP_DIR/zip-listing.txt"
/usr/bin/unzip -Z1 "$zip_path" > "$zip_listing" ||
  { fail '無法讀取 release ZIP'; exit 1; }
while IFS= read -r entry; do
  [[ -n "$entry" ]] || continue
  [[ "$entry" != /* && "$entry" != *'../'* && "$entry" == "$root_name/"* ]] ||
    { fail 'release ZIP 含有不安全或非預期的路徑'; exit 1; }
done < "$zip_listing"

extract_dir="$TEMP_DIR/extracted"
/bin/mkdir "$extract_dir" ||
  { fail '無法建立解壓縮目錄'; exit 1; }
/usr/bin/unzip -q "$zip_path" -d "$extract_dir" ||
  { fail 'release ZIP 解壓縮失敗'; exit 1; }
package_root="$extract_dir/$root_name"
[[ -d "$package_root" ]] ||
  { fail 'release ZIP 缺少唯一的版本資料夾'; exit 1; }
if /usr/bin/find "$package_root" -type l -print -quit | /usr/bin/grep -q .; then
  fail 'release ZIP 不允許符號連結'
  exit 1
fi

release_info="$package_root/release-info.json"
new_extension="$package_root/chrome-extension"
new_updater="$package_root/updater"
new_extension_manifest="$new_extension/manifest.json"
[[ -f "$release_info" && -f "$new_extension_manifest" ]] ||
  { fail 'release ZIP 缺少必要版本資訊或擴充功能 manifest'; exit 1; }

package_schema="$(json_value "$release_info" schemaVersion)" ||
  { fail 'release-info.json 格式無效'; exit 1; }
package_version="$(json_value "$release_info" version)" ||
  { fail 'release-info.json 缺少版本'; exit 1; }
package_commit="$(json_value "$release_info" commit)" ||
  { fail 'release-info.json 缺少 commit'; exit 1; }
extension_version="$(json_value "$new_extension_manifest" version)" ||
  { fail 'ZIP 內擴充功能版本無效'; exit 1; }

[[ "$package_schema" == '1' &&
   "$package_version" == "$release_version" &&
   "$package_commit" == "$release_commit" ]] ||
  { fail 'release-info.json 與已簽章的 release manifest 不一致'; exit 1; }
[[ "$extension_version" == "$release_version" ]] ||
  { fail 'ZIP 內擴充功能版本與已簽章的 release manifest 不一致'; exit 1; }

updater_files=(
  update-macos.sh
  native-host-macos.sh
  trusted-update-key.pem
  trusted-update-key.json
)
for name in "${updater_files[@]}"; do
  [[ -f "$new_updater/$name" ]] ||
    { fail "release ZIP 缺少 updater/$name"; exit 1; }
done
/usr/bin/cmp -s "$new_updater/trusted-update-key.pem" "$PUBLIC_KEY_PATH" ||
  { fail 'release ZIP 嘗試未經核准地更換更新公開金鑰'; exit 1; }
/usr/bin/cmp -s "$new_updater/trusted-update-key.json" "$trusted_key_json" ||
  { fail 'release ZIP 嘗試未經核准地更換更新金鑰識別資料'; exit 1; }

extension_stage="$INSTALL_DIR/chrome-extension.updating.$$"
backup_dir="$INSTALL_DIR/chrome-extension.backup"
updater_backup="$TEMP_DIR/updater-backup"
/bin/mkdir "$updater_backup" ||
  { fail '無法建立更新器備份'; exit 1; }
/bin/rm -rf "$extension_stage"
/bin/cp -R "$new_extension" "$extension_stage" ||
  { fail '無法準備新版擴充功能'; exit 1; }

existing_updater_files=()
for name in "${updater_files[@]}"; do
  if [[ -f "$INSTALL_DIR/$name" ]]; then
    /bin/cp "$INSTALL_DIR/$name" "$updater_backup/$name" ||
      { fail "無法備份 $name"; exit 1; }
    existing_updater_files+=("$name")
  fi
  /bin/cp "$new_updater/$name" "$INSTALL_DIR/$name.updating.$$" ||
    { fail "無法準備新版 $name"; exit 1; }
done
/bin/chmod 755 \
  "$INSTALL_DIR/update-macos.sh.updating.$$" \
  "$INSTALL_DIR/native-host-macos.sh.updating.$$" ||
  { fail '無法設定新版更新器執行權限'; exit 1; }
/bin/chmod 644 \
  "$INSTALL_DIR/trusted-update-key.pem.updating.$$" \
  "$INSTALL_DIR/trusted-update-key.json.updating.$$" ||
  { fail '無法設定新版公開金鑰權限'; exit 1; }

release_info_stage="$INSTALL_DIR/release-info.json.updating.$$"
/bin/cp "$release_info" "$release_info_stage" ||
  { fail '無法準備新版 release-info.json'; exit 1; }

replacement_started=0
apply_update() {
  /bin/rm -rf "$backup_dir" || return 1
  /bin/mv "$extension_dir" "$backup_dir" || return 1
  replacement_started=1
  /bin/mv "$extension_stage" "$extension_dir" || return 1
  for name in "${updater_files[@]}"; do
    /bin/mv "$INSTALL_DIR/$name.updating.$$" "$INSTALL_DIR/$name" || return 1
  done
  /bin/mv "$release_info_stage" "$INSTALL_DIR/release-info.json" || return 1
}

rollback_update() {
  /bin/rm -rf "$extension_dir"
  if [[ -d "$backup_dir" ]]; then
    /bin/mv "$backup_dir" "$extension_dir"
  fi
  for name in "${updater_files[@]}"; do
    /bin/rm -f "$INSTALL_DIR/$name.updating.$$"
    if [[ -f "$updater_backup/$name" ]]; then
      /bin/cp "$updater_backup/$name" "$INSTALL_DIR/$name"
    elif (( ${existing_updater_files[(Ie)$name]} == 0 )); then
      /bin/rm -f "$INSTALL_DIR/$name"
    fi
  done
  /bin/rm -f "$release_info_stage"
}

if ! apply_update; then
  if (( replacement_started == 1 )); then
    rollback_update
  fi
  fail '套用新版時發生錯誤，已還原舊版'
  exit 1
fi

log "安全更新完成：$local_version → $release_version（commit $release_commit）"
exit 0
