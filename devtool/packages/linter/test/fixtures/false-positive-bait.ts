// discoveryProvider: { url: "https://indexer.example" }  <- commented out, must NOT fire
const docs = `createPrivateTransfers({ discoveryProvider: { url: "x" } })`;
const notOurs = createSomethingElse({ discoveryProvider: { url: "https://x" } });
export { docs, notOurs };

// The loose-predicate trap the namespace widening opens: a method with a matching name on
// something that is NOT a namespace import. Over-reporting here is how the tool gets switched
// off, after which it reports nothing at all.
const notSdk = { createPrivateTransfers: (_: unknown) => null };
const alsoNot = notSdk.createPrivateTransfers({ discoveryProvider: { url: "https://x" } });
class Sdk { static IndexerDiscoveryProvider = class {}; }
const nope = new Sdk.IndexerDiscoveryProvider(url, pool);
export { alsoNot, nope };
