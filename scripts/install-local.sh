#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Browser Connector MVP currently supports macOS only." >&2
  exit 1
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
install_dir="${BROWSER_CONNECTOR_INSTALL_DIR:-$HOME/.local/bin}"
binary_path="$install_dir/browser-connector"

case "$install_dir" in
  "$HOME"/*) ;;
  *) echo "Install directory must be inside your home directory: $install_dir" >&2; exit 1 ;;
esac

mkdir -p "$install_dir"
(cd "$repo_root" && cargo build --release --locked -p browser-connector)
install -m 0755 "$repo_root/target/release/browser-connector" "$binary_path"
(cd "$repo_root/extension" && npm install && npm run build)

echo "Installed binary: $binary_path"
echo "Built unpacked extension: $repo_root/extension/dist"
echo "Load that directory from chrome://extensions and confirm extension ID:"
echo "  kppdjhnonomijdjifhobgeaipejojbho"
echo "Then register native messaging:"
echo "  $binary_path install --extension-id kppdjhnonomijdjifhobgeaipejojbho --host-id codex"
