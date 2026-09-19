let received = 0;
self.onmessage = ({ data }) => {
  if (data.channel) { data.channel.onmessage = () => received++; postMessage({ ready: true }); }
  else postMessage({ received });
};
