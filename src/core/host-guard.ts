import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { CommerceError } from './errors.js';

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]] as const) blocked.addSubnet(net, prefix, 'ipv6');

/** True for loopback, private, link-local, CGNAT, unspecified, multicast, documentation and NAT64 addresses (incl. IPv4-mapped IPv6). */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 0) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isBlockedIp(mapped[1] as string);
  return blocked.check(ip, v === 4 ? 'ipv4' : 'ipv6');
}

const NAME_BLOCK = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan)$/i;

/** Static check (no DNS): rejects blocked names and literal IPs. */
export function assertPublicHostname(hostname: string) {
  const h = hostname.replace(/^\[|\]$/g, '');
  if (NAME_BLOCK.test(h)) throw new CommerceError('CONFIG_INVALID', `Host ${h} is not a public hostname`);
  if (isIP(h) && isBlockedIp(h)) throw new CommerceError('CONFIG_INVALID', `Host ${h} is a private/loopback/reserved address`);
}

/** Resolves the name and rejects if ANY address is non-public. Re-run before each request to narrow DNS-rebinding windows. */
export async function assertResolvesPublic(hostname: string) {
  const h = hostname.replace(/^\[|\]$/g, '');
  assertPublicHostname(h);
  if (isIP(h)) return;
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(h, { all: true });
  } catch {
    throw new CommerceError('NETWORK_ERROR', `Cannot resolve store host ${h}`);
  }
  const bad = addrs.find((a) => isBlockedIp(a.address));
  if (bad) throw new CommerceError('CONFIG_INVALID', `Store host ${h} resolves to a non-public address; refusing to send credentials there`);
}
