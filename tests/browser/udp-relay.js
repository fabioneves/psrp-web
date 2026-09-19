import { createSocket } from 'node:dgram';

// Stands between the browser and the server's WebRTC port the way a router does, and loses datagrams on the way to the
// browser. The loss is below SCTP, where retransmission can see it; rehearsed loss inside the server is not. The isolated
// instance advertises this relay's port (WEBRTC_PUBLIC_PORT=18445) and listens on 18444 itself.
export async function startRelay({ listen = 18445, server = 18444, lossPercent = 0, after = 400, delayMs = 0 } = {}) {
  const socket = createSocket('udp4');
  const counts = { toBrowser: 0, toServer: 0, lost: 0 };
  let browser = null;
  // Each direction is held back by delayMs, so the round trip a retransmission has to fit into is twice that.
  const send = (datagram, port, address) => delayMs ? setTimeout(() => socket.send(datagram, port, address), delayMs) : socket.send(datagram, port, address);
  socket.on('message', (datagram, from) => {
    if (from.port === server && from.address === '127.0.0.1') {
      if (!browser) return;
      // Connection setup gets through untouched; loss starts once video is flowing.
      if (++counts.toBrowser > after && Math.random() * 100 < lossPercent) { counts.lost++; return; }
      send(datagram, browser.port, browser.address);
    } else {
      browser = from; counts.toServer++;
      send(datagram, server, '127.0.0.1');
    }
  });
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(listen, '127.0.0.1', resolve); });
  return { counts, close: () => new Promise(resolve => { delayMs = 0; socket.close(resolve); }) };
}
