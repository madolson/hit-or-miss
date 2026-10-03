import Valkey from 'iovalkey';

export const COMMAND_STREAM = 'valkey:commands';

const opts = {
  host: process.env.VALKEY_HOST || '127.0.0.1',
  port: Number(process.env.VALKEY_PORT || 6379),
  tls: process.env.VALKEY_TLS === '1' ? {} : undefined,
  // After a failover the old primary turns replica; reconnect and resend.
  reconnectOnError: (err) => (err.message.startsWith('READONLY') ? 2 : false),
};

export const client = () => new Valkey(opts);

// The ready check's INFO reply races with MONITOR output, so skip it.
export const monitor = () => new Valkey({ ...opts, lazyConnect: true, enableReadyCheck: false }).monitor();
