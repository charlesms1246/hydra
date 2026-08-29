/**
 * Every version this stack needs, in one place.
 *
 * Standing rule 5: pin every toolchain version. The failure mode of this category of
 * tool is "works on the author's machine", and these are the exact versions that were
 * verified end-to-end on 2026-08-29 (upstream e2e devnet suite green).
 *
 * Sourced from upstream `.tool-versions` plus the devnet release the SDK README names.
 */

export const UPSTREAM_SHA = "980da8affafb9f8350975ca93c03b2299a31ac9b";
export const UPSTREAM_REPO = "https://github.com/starkware-libs/starknet-privacy";

export const PINS = {
  scarb: { exact: "2.18.0", cmd: ["scarb", "--version"], match: /scarb (\S+)/ },
  snforge: { exact: "0.63.0", cmd: ["snforge", "--version"], match: /snforge (\S+)/ },
  "starknet-devnet": {
    exact: "0.8.0-rc.3",
    cmd: ["starknet-devnet", "--version"],
    match: /starknet-devnet (\S+)/,
  },
};

/** Node is a floor, not an exact pin: >= 24 is required by ohttp-ts (WebCrypto). */
export const NODE_MIN_MAJOR = 24;

/** Install lines that need no root. The upstream README uses sudo; this does not. */
export const INSTALL_HINTS = {
  scarb:
    "curl --proto '=https' --tlsv1.2 -sSf https://docs.swmansion.com/scarb/install.sh | sh -s -- -v 2.18.0",
  snforge:
    "curl -fsSL https://raw.githubusercontent.com/foundry-rs/starknet-foundry/master/scripts/install.sh | sh && snfoundryup -v 0.63.0",
  "starknet-devnet":
    "curl -fsSL https://github.com/0xSpaceShard/starknet-devnet/releases/download/v0.8.0-rc.3/starknet-devnet-$(uname -m)-apple-darwin.tar.gz | tar -xz -C ~/.local/bin",
};

/** Paths inside the upstream checkout that must exist before `up` can run. */
export const ARTIFACTS = {
  pool: "target/dev/privacy_Privacy.contract_class.json",
  discoveryService: "target/release/discovery-service",
  sdkDist: "sdk/dist/index.js",
  // Not listed in upstream's e2e README prerequisites, but e2e depends on
  // `file:../client` and three devnet tests fail to resolve `/signers` without it.
  clientDist: "client/dist/signers/index.js",
};

export const BUILD_HINTS = {
  pool: "scarb build -p privacy -p vesu_lending_anonymizer -p ekubo_swap_anonymizer -p shadow_account_anonymizer",
  discoveryService: "cargo build --release -p discovery-service",
  sdkDist: "cd sdk && npm ci && npm run build",
  clientDist: "cd client && npm ci && npm run build",
};
