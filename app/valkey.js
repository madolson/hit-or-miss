import os from 'node:os';
import Valkey from 'iovalkey';

export const COMMAND_STREAM = 'valkey:commands';
const SRC = os.hostname();

const opts = {
  host: process.env.VALKEY_HOST || '127.0.0.1',
  port: Number(process.env.VALKEY_PORT || 6379),
  tls: process.env.VALKEY_TLS === '1' ? {} : undefined,
  // After a failover the old primary turns replica; reconnect and resend.
  reconnectOnError: (err) => (err.message.startsWith('READONLY') ? 2 : false),
};

// Writes to and reads from the command stream go through unlogged
// connections. Logging them would make every log entry produce another one.
export const rawClient = () => new Valkey(opts);
export const logger = rawClient();

function fmt(args) {
  const s = args.map((a) => (Buffer.isBuffer(a) ? a.toString() : String(a))).join(' ');
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

// A client whose every command is appended to the command stream.
export function loggedClient() {
  const c = new Valkey(opts);
  const send = c.sendCommand.bind(c);
  c.sendCommand = (command, stream) => {
    logger
      .xadd(COMMAND_STREAM, 'MAXLEN', '~', '5000', '*',
        'src', SRC, 'cmd', command.name.toUpperCase(), 'args', fmt(command.args))
      .catch(() => {});
    return send(command, stream);
  };
  return c;
}
