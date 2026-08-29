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
  "universal-sierra-compiler": {
    exact: null, // no pin published upstream; presence is what matters
    cmd: ["universal-sierra-compiler", "--version"],
    match: /universal-sierra-compiler (\S+)/,
  },
  "starknet-devnet": {
    exact: "0.8.0-rc.3",
    cmd: ["starknet-devnet", "--version"],
    match: /starknet-devnet (\S+)/,
  },
};

/** Node is a floor, not an exact pin: >= 24 is required by ohttp-ts (WebCrypto). */
export const NODE_MIN_MAJOR = 24;

/**
 * The devnet release asset is named per platform, so build it rather than
 * hardcode a triple — the macOS-only string was simply wrong on Linux.
 */
function devnetAsset() {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return process.platform === "darwin"
    ? `starknet-devnet-${arch}-apple-darwin.tar.gz`
    : `starknet-devnet-${arch}-unknown-linux-gnu.tar.gz`;
}

/** Install lines that need no root. The upstream README uses sudo; this does not. */
export const INSTALL_HINTS = {
  scarb:
    "curl --proto '=https' --tlsv1.2 -sSf https://docs.swmansion.com/scarb/install.sh | sh -s -- -v 2.18.0",
  snforge:
    "curl -fsSL https://raw.githubusercontent.com/foundry-rs/starknet-foundry/master/scripts/install.sh | sh && snfoundryup -v 0.63.0",
  // snfoundryup ships USC; it has no installer of its own and is absent from
  // upstream's .tool-versions, so it looked unfixable when it is not.
  "universal-sierra-compiler":
    "curl -fsSL https://raw.githubusercontent.com/foundry-rs/starknet-foundry/master/scripts/install.sh | sh && snfoundryup -v 0.63.0",
  // mkdir first: tar -C into a directory that does not exist fails, and on a
  // clean machine ~/.local/bin usually does not.
  "starknet-devnet":
    `mkdir -p ~/.local/bin && curl -fsSL https://github.com/0xSpaceShard/starknet-devnet/releases/download/v0.8.0-rc.3/${devnetAsset()} | tar -xz -C ~/.local/bin`,
};

/** Paths inside the upstream checkout that must exist before `up` can run. */
export const ARTIFACTS = {
  pool: "target/dev/privacy_Privacy.contract_class.json",
  discoveryService: "target/release/discovery-service",
  sdkDist: "sdk/dist/index.js",
  // Not listed in upstream's e2e README prerequisites, but e2e depends on
  // `file:../client` and three devnet tests fail to resolve `/signers` without it.
  clientDist: "client/dist/signers/index.js",
  // Test-target contracts. `scarb build -p privacy` does NOT produce these; the
  // eth712 devnet tests need the `-t` target and fail in universal-sierra-compiler
  // without it.
  poolTestContracts: "target/dev/privacy_unittest.test.starknet_artifacts.json",
  // e2e/contracts/ are separate Scarb projects, not workspace members.
  testToken: "e2e/contracts/test-token/target/dev/test_token_TestToken.contract_class.json",
};

export const BUILD_HINTS = {
  pool: "scarb build -p privacy -p vesu_lending_anonymizer -p ekubo_swap_anonymizer -p shadow_account_anonymizer",
  discoveryService: "cargo build --release -p discovery-service",
  sdkDist: "cd sdk && npm ci && npm run build",
  clientDist: "cd client && npm ci && npm run build",
  poolTestContracts: "scarb build -t -p privacy -p shadow_account_anonymizer",
  testToken:
    "(cd e2e/contracts/test-token && scarb build) && (cd e2e/contracts/ekubo && scarb build) && (cd e2e/contracts/vesu && scarb build --ignore-cairo-version)",
};

/**
 * Traps found the hard way while getting upstream's e2e suite green. Printed by
 * `hydra doctor` because none of them are in upstream's e2e README.
 */
export const GOTCHAS = [
  "Do NOT set RUST_LOG=error for the e2e suite. The harness waits for the discovery " +
    "service to log \"API server listening\", which is emitted at INFO — silencing it " +
    "makes every devnet test fail with a 60s timeout that looks like a hang.",
  "e2e/contracts/vesu needs `scarb build --ignore-cairo-version`; it pins a different " +
    "Cairo version. Upstream's script hides this behind `asdf exec scarb`.",
  "discovery-service processes leak when a test's beforeAll fails (shutdown only runs " +
    "in afterAll). They hold ports and poison later runs. Check with " +
    "`pgrep -f discovery-service` and kill strays before re-running.",
  "universal-sierra-compiler is required but is not in upstream .tool-versions. " +
    "snfoundryup installs it.",
  "WSL2 in networkingMode=mirrored blackholes connections to unbound 127.0.0.1 ports " +
    "instead of refusing them (::1 still refuses, so it looks fine until something probes " +
    "IPv4). starknet-devnet's npm wrapper treats anything but ECONNREFUSED as fatal while " +
    "picking a port, so `hydra up` dies with `connect ETIMEDOUT 127.0.0.1:6050` after ~135s " +
    "and never spawns devnet. The `loopback refuses` doctor row detects this.",
];
