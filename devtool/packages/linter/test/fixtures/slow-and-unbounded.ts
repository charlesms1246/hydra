const a = new ContractDiscoveryProvider(pool);
const b = new ContractDiscoveryProvider(pool, { rateLimit: { concurrency: 8 } });
const c = new ContractDiscoveryProvider(pool, { rateLimit: {} });
