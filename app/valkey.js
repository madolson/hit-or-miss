import Valkey from 'iovalkey';

export const COMMAND_STREAM = 'valkey:commands';

// Cluster mode with a single shard; durability requires cluster mode.
const startup = [{
  host: process.env.VALKEY_HOST || '127.0.0.1',
  port: Number(process.env.VALKEY_PORT || 6379),
}];
const opts = {
  // ElastiCache TLS certificates name the hostnames, so connect by hostname.
  dnsLookup: (address, cb) => cb(null, address),
  redisOptions: { tls: process.env.VALKEY_TLS === '1' ? {} : undefined },
};

export const client = () => new Valkey.Cluster(startup, opts);

export const primaryOf = (cluster) => cluster.nodes('master')[0];

// MONITOR the shard primary. The ready check's INFO reply races with MONITOR
// output, so skip it.
export const monitor = (node) =>
  new Valkey({ ...node.options, lazyConnect: true, enableReadyCheck: false }).monitor();
