# Formula for the Browser Connector companion.
#
# This is a formula rather than a cask on purpose: a cask is quarantined and Homebrew
# audits it for notarization, which this free build does not have. A formula in a
# private tap installs the same prebuilt universal binary without quarantine.
#
# The npm package is published, and the sha256 below is the registry tarball.
# This file is also served from Formula/browser-connector.rb in this repository, so
# users can tap the repository directly:
#   brew tap benedictjeremiahh/browser-connector https://github.com/benedictjeremiahh/browser-connector
class BrowserConnector < Formula
  desc "Local MCP server and Chrome native-messaging host for Browser Connector"
  homepage "https://github.com/benedictjeremiahh/browser-connector"
  url "https://registry.npmjs.org/@ceebee/browser-connector/-/browser-connector-0.4.0.tgz"
  sha256 "8e8de0b701b4b7a920411e9628bc44cd7e17e79ac98ec8df7bd84dd2aeabffd8"
  license "Apache-2.0"

  depends_on :macos

  def install
    bin.install "bin/browser-connector" => "browser-connector"
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
