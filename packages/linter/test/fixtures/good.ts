import { ContractDiscoveryProvider } from "@starkware-libs/starknet-privacy-sdk";
export const d = new ContractDiscoveryProvider(pool, { rateLimit: { concurrency: 32 } });
export const t = createPrivateTransfers({
  discoveryProvider: { url: "https://indexer.example", ohttp: true },
  poolContractAddress: "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91",
});
