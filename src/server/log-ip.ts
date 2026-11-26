// The only form of a client address that may reach a log (spec 8.3): IPv4 cut to /16, IPv6 to /48, like
// nginx in front. Rate limits keep using the full request.ip, the guest limit its limitKey, in memory only.
import { isIPv4, isIPv6 } from "node:net";

export function logIp(ip: string | undefined): string {
  if (!ip) return "invalid";
  if (isIPv4(ip)) return `${ip.split(".").slice(0, 2).join(".")}.0.0`;
  const groups = ipv6Groups(ip);
  if (!groups) return "invalid";
  // IPv4-mapped (::ffff:a.b.c.d, also written in hex): the IPv4 rule applies.
  if (isMapped(groups)) return `${groups[6]! >> 8}.${groups[6]! & 255}.0.0`;
  return `${groups.slice(0, 3).map((g) => g.toString(16)).join(":")}::`;
}

// Whom a per-address limit counts: an IPv4 address, or the /64 an IPv6 host gets (one line, one home);
// counted per full IPv6 address, one connection could take as many slots as it has addresses.
export function limitKey(ip: string): string {
  const groups = isIPv4(ip) ? null : ipv6Groups(ip);
  if (!groups) return ip;
  if (isMapped(groups)) return `${groups[6]! >> 8}.${groups[6]! & 255}.${(groups[7]! >> 8)}.${groups[7]! & 255}`;
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

const isMapped = (groups: number[]) => groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;

// Eight 16-bit groups, or null when it is not an IPv6 address.
function ipv6Groups(ip: string): number[] | null {
  const address = ip.replace(/%[^%]*$/, ""); // zone id, e.g. fe80::1%eth0
  if (!address.includes(":") || !isIPv6(address)) return null;
  // Expand to eight 16-bit groups: a trailing dotted IPv4 becomes two groups, "::" the missing zeros.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  const hex = dotted ? `${address.slice(0, dotted.index)}${(+dotted[1]! * 256 + +dotted[2]!).toString(16)}:${(+dotted[3]! * 256 + +dotted[4]!).toString(16)}` : address;
  const [head = "", tail] = hex.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  return [...front, ...Array<string>(tail === undefined ? 0 : 8 - front.length - back.length).fill("0"), ...back].map((g) => parseInt(g, 16));
}
