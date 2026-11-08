# Formula for the Browser Connector companion.
#
# This is a formula rather than a cask on purpose: a cask is quarantined and Homebrew
# audits it for notarization, which this free build does not have. A formula in a
# private tap installs the same prebuilt universal binary without quarantine.
#
# Publish the npm package first, then replace SHA256 with the tarball's sha256
# (scripts/package-npm.mjs prints it). Copy this file to Formula/browser-connector.rb
# in the benedictjeremiahh/homebrew-tap repository.
class BrowserConnector < Formula
  desc "Local MCP server and Chrome native-messaging host for Browser Connector"
  homepage "https://github.com/benedictjeremiahh/browser-connector"
  url "https://registry.npmjs.org/browser-connector/-/browser-connector-0.4.0.tgz"
  sha256 "SHA256"
  license "Apache-2.0"

  depends_on :macos

  def install
    bin.install "package/bin/browser-connector" => "browser-connector"
  end

  def caveats
    <<~EOS
      Register Chrome's native-messaging host once:
        browser-connector install --executable #{opt_bin}/browser-connector

      Then restart Chrome and approve Host Pairing in the Connector side panel.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/browser-connector --version")
  end
end
