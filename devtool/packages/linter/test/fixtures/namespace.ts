// `import * as sdk` is an ordinary spelling and used to produce ZERO findings and exit 0 —
// not even HYD000, against a header promising indirection degrades to UNKNOWN.
import * as sdk from "@starkware-libs/starknet-privacy-sdk";
import { createPrivateTransfers as cpt } from "@starkware-libs/starknet-privacy-sdk";

export const a = sdk.createPrivateTransfers({ discoveryProvider: { url: "https://indexer.example" } });
export const b = new sdk.IndexerDiscoveryProvider(url, pool);

// Renamed on import. The imported name is what it is.
export const c = cpt({ discoveryProvider: { url: "https://indexer.example" } });
