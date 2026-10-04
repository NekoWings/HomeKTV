import os from 'node:os';

export function inviteUrls(port, localAddress, interfaces = os.networkInterfaces()) {
  const addresses = [...new Set(Object.values(interfaces).flatMap(list => list || [])
    .filter(item => item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.'))
    .map(item => item.address))];
  const local = (localAddress || '').replace(/^::ffff:/, '');
  addresses.sort((a, b) => Number(b === local) - Number(a === local));
  return addresses.map(address => `http://${address}:${port}`);
}
