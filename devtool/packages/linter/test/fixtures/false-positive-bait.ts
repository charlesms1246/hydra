// discoveryProvider: { url: "https://indexer.example" }  <- commented out, must NOT fire
const docs = `createPrivateTransfers({ discoveryProvider: { url: "x" } })`;
const notOurs = createSomethingElse({ discoveryProvider: { url: "https://x" } });
export { docs, notOurs };
