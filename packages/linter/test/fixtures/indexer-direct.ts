const bare = new IndexerDiscoveryProvider(url, pool);
const off = new IndexerDiscoveryProvider(url, pool, { ohttp: false });
const on = new IndexerDiscoveryProvider(url, pool, { ohttp: true });
