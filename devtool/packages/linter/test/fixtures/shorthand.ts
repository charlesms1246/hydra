// Every line here is an ordinary TypeScript spelling that the analyzer used to read as
// "the property is absent". HYD001's own `detail` quotes the first one.
const url = "https://indexer.example";
const ohttp = true;
const rateLimit = { concurrency: 32 };
const concurrency = 32;

// A url this tool cannot read is still a url, and OHTTP is still absent. HYD001.
export const a = createPrivateTransfers({ discoveryProvider: { url } });

// OHTTP is set, to something not knowable from this file. Not an error — UNKNOWN.
export const b = createPrivateTransfers({ discoveryProvider: { url: "https://x", ohttp } });

// The whole config comes from elsewhere. UNKNOWN, not "no discoveryProvider key".
export const c = createPrivateTransfers({ ...base });

// rateLimit is right there. Reporting "options present but no rateLimit" was false.
export const d = new ContractDiscoveryProvider(pool, { rateLimit });

// And the same one level down.
export const e = new ContractDiscoveryProvider(pool, { rateLimit: { concurrency } });
