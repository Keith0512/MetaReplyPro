#!/bin/zsh
# MetaReplyPro macOS 本機安裝器。
# 只接受已驗證並解壓後的正式 release，不會從浮動的 GitHub main 下載或執行程式。

set -u

EXTENSION_ID='gnekicgafkpbmafejjcbaagcpfnmfjbh'
SCRIPT_DIR="${0:A:h}"
SOURCE_DIR="${SCRIPT_DIR:h}"
INSTALL_DIR="$HOME/Library/Application Support/MetaReplyPro"
NATIVE_HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

fail() {
  print -u2 -- "安裝失敗：$1"
  exit 1
}

json_value() {
  /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null
}

while (( $# > 0 )); do
  case "$1" in
    --source-dir)
      (( $# >= 2 )) || fail '--source-dir 缺少路徑'
      SOURCE_DIR="${2:A}"
      shift 2
      ;;
    --install-dir)
      (( $# >= 2 )) || fail '--install-dir 缺少路徑'
      INSTALL_DIR="${2:A}"
      shift 2
      ;;
    --native-host-dir)
      (( $# >= 2 )) || fail '--native-host-dir 缺少路徑'
      NATIVE_HOST_DIR="${2:A}"
      shift 2
      ;;
    *)
      fail "不支援的參數：$1"
      ;;
  esac
done

RELEASE_INFO="$SOURCE_DIR/release-info.json"
SOURCE_EXTENSION="$SOURCE_DIR/chrome-extension"
SOURCE_UPDATER="$SOURCE_DIR/updater"
SOURCE_EXTENSION_MANIFEST="$SOURCE_EXTENSION/manifest.json"

[[ -f "$RELEASE_INFO" ]] || fail '安裝來源缺少 release-info.json；請使用已簽章的正式 release'
[[ -f "$SOURCE_EXTENSION_MANIFEST" ]] || fail '安裝來源缺少 chrome-extension/manifest.json'

required_updater_files=(
  update-macos.sh
  native-host-macos.sh
  trusted-update-key.pem
  trusted-update-key.json
)
for name in "${required_updater_files[@]}"; do
  [[ -f "$SOURCE_UPDATER/$name" ]] || fail "安裝來源缺少 updater/$name"
done

release_schema="$(json_value "$RELEASE_INFO" schemaVersion)" ||
  fail 'release-info.json 格式無效'
release_version="$(json_value "$RELEASE_INFO" version)" ||
  fail 'release-info.json 缺少版本'
release_commit="$(json_value "$RELEASE_INFO" commit)" ||
  fail 'release-info.json 缺少 commit'
extension_version="$(json_value "$SOURCE_EXTENSION_MANIFEST" version)" ||
  fail '擴充功能 manifest.json 缺少版本'

[[ "$release_schema" == '1' ]] || fail '不支援的 release-info.json 格式'
[[ "$release_version" == "$extension_version" ]] ||
  fail 'release-info.json 與擴充功能版本不一致'
[[ "$release_version" =~ '^[0-9]+(\.[0-9]+){2,3}$' ]] ||
  fail 'release 版本號無效'
[[ "$release_commit" =~ '^[0-9a-f]{40}$' ]] ||
  fail 'release commit SHA 無效'

print -- "正在安裝 MetaReplyPro $release_version…"

/bin/mkdir -p "$INSTALL_DIR" || fail '無法建立安裝目錄'
extension_stage="$INSTALL_DIR/chrome-extension.installing.$$"
release_info_stage="$INSTALL_DIR/release-info.json.installing.$$"

/bin/rm -rf "$extension_stage"
/bin/cp -R "$SOURCE_EXTENSION" "$extension_stage" ||
  fail '無法複製擴充功能'
/bin/cp "$RELEASE_INFO" "$release_info_stage" ||
  fail '無法複製版本資訊'

for name in "${required_updater_files[@]}"; do
  /bin/cp "$SOURCE_UPDATER/$name" "$INSTALL_DIR/$name.installing.$$" ||
    fail "無法複製 $name"
done
/bin/chmod 755 \
  "$INSTALL_DIR/update-macos.sh.installing.$$" \
  "$INSTALL_DIR/native-host-macos.sh.installing.$$" ||
  fail '無法設定更新器執行權限'
/bin/chmod 644 \
  "$INSTALL_DIR/trusted-update-key.pem.installing.$$" \
  "$INSTALL_DIR/trusted-update-key.json.installing.$$" ||
  fail '無法設定公開金鑰權限'

if [[ -d "$INSTALL_DIR/chrome-extension" ]]; then
  /bin/rm -rf "$INSTALL_DIR/chrome-extension.backup"
  /bin/mv "$INSTALL_DIR/chrome-extension" "$INSTALL_DIR/chrome-extension.backup" ||
    fail '無法備份既有版本'
fi

if ! /bin/mv "$extension_stage" "$INSTALL_DIR/chrome-extension"; then
  if [[ -d "$INSTALL_DIR/chrome-extension.backup" ]]; then
    /bin/mv "$INSTALL_DIR/chrome-extension.backup" "$INSTALL_DIR/chrome-extension"
  fi
  fail '無法啟用新版本'
fi

for name in "${required_updater_files[@]}"; do
  if ! /bin/mv "$INSTALL_DIR/$name.installing.$$" "$INSTALL_DIR/$name"; then
    fail "無法安裝 $name"
  fi
done
/bin/mv "$release_info_stage" "$INSTALL_DIR/release-info.json" ||
  fail '無法安裝版本資訊'

/bin/mkdir -p "$NATIVE_HOST_DIR" ||
  fail '無法建立 Chrome Native Messaging 目錄'
host_manifest="$NATIVE_HOST_DIR/com.metareplypro.updater.json"
host_manifest_stage="$NATIVE_HOST_DIR/com.metareplypro.updater.installing.$$.json"
host_manifest_plist="$NATIVE_HOST_DIR/com.metareplypro.updater.installing.$$.plist"

/usr/bin/plutil -create xml1 "$host_manifest_plist" ||
  fail '無法建立 Native Messaging 設定'
/usr/bin/plutil -insert name -string 'com.metareplypro.updater' "$host_manifest_plist" ||
  fail '無法設定 Native Messaging 名稱'
/usr/bin/plutil -insert description -string 'MetaReplyPro signed release updater' "$host_manifest_plist" ||
  fail '無法設定 Native Messaging 說明'
/usr/bin/plutil -insert path -string "$INSTALL_DIR/native-host-macos.sh" "$host_manifest_plist" ||
  fail '無法設定 Native Messaging 路徑'
/usr/bin/plutil -insert type -string 'stdio' "$host_manifest_plist" ||
  fail '無法設定 Native Messaging 類型'
/usr/bin/plutil -insert allowed_origins -json "[\"chrome-extension://$EXTENSION_ID/\"]" "$host_manifest_plist" ||
  fail '無法設定允許的擴充功能'
/usr/bin/plutil -convert json -o "$host_manifest_stage" "$host_manifest_plist" ||
  fail '無法輸出 Native Messaging JSON 設定'
/bin/rm -f "$host_manifest_plist"
/bin/chmod 644 "$host_manifest_stage"
/bin/mv "$host_manifest_stage" "$host_manifest" ||
  fail '無法註冊 Native Messaging'

print -n -- "$INSTALL_DIR/chrome-extension" | /usr/bin/pbcopy 2>/dev/null || true

print
print -- "安裝完成：MetaReplyPro $release_version"
print -- '接下來請手動做一次（只有第一次需要）：'
print -- '  1. 開啟 Chrome，網址列輸入 chrome://extensions'
print -- '  2. 開啟右上角的「開發人員模式」'
print -- '  3. 點「載入未封裝項目」'
print -- '  4. 貼上已複製的資料夾路徑：'
print -- "     $INSTALL_DIR/chrome-extension"
print
print -- '日後可直接在擴充功能設定頁按「立即更新」。'
print -- '更新器會先驗證 release 簽章、commit、版本與 SHA-256。'
