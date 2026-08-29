import { createPrivateTransfers } from "@starkware-libs/starknet-privacy-sdk";
export const t = createPrivateTransfers({
  account,
  viewingKeyProvider,
  provingProvider: { url: "https://prover.example", chainId },
  discoveryProvider: { url: "https://indexer.example" },
  poolContractAddress: "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a",
});
