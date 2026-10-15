import { createRelay } from '../../src/relay.mjs';

const relay = createRelay({
  getPro: async () => ({ token: 'fixture-pro', accountId: 'fixture-account' }),
  getBusiness: async () => null,
  upstream: `http://127.0.0.1:${process.argv[2]}`,
  allowTestUpstream: true,
  audit: event => { if (event.event === 'upgrade_socket_error') process.send({ event: event.event, errorCode: event.errorCode }); },
});
if (process.argv[3] === 'inject-reset') {
  relay.server.on('upgrade', (_req, socket) => {
    // Deterministic equivalent of a TCP read reset after the 426 reply.
    setTimeout(() => socket.destroy(Object.assign(new Error('fixture TCP reset'), { code: 'ECONNRESET' })), 25);
  });
}
const port = await relay.listen(0);
process.send({ port });
