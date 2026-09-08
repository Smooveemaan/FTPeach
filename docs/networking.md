# Networking and protocol modes

## Proxy support

The global proxy setting applies to new FTP, FTPS, SFTP, and WebDAV connections. FTP/FTPS and
SFTP tunnel their TCP connections through SOCKS4/4a, SOCKS5, or HTTP CONNECT. WebDAV uses the
same proxy types through its HTTP client. Proxy credentials are stored in the protected vault.

SOCKS4 supports IPv4 targets and DNS names through SOCKS4a, but the protocol has no IPv6 address
type. Use SOCKS5 or HTTP CONNECT for an IPv6 literal. FTP active mode is disabled while a proxy is
enabled because an outbound proxy tunnel cannot accept the server's reverse data connection.

## FTP passive and active modes

Passive mode is the default and recommended mode. The client opens both the control connection
and each data connection, so it normally works through client-side NAT and outbound firewalls. A
server behind NAT must publish a reachable passive port range. FTPeach uses extended passive mode
when the server supports it and ignores an unusable address advertised by a proxied server while
retaining the advertised port.

Active mode is an opt-in compatibility setting. The server connects back to the client for each
data transfer. It therefore requires an inbound firewall rule and a client address/port reachable
from the server; ordinary NAT usually prevents it unless port forwarding is configured. Active
mode is not a workaround for client-side NAT and is unavailable with a proxy. SFTP and WebDAV use
only client-initiated connections and do not have FTP data-channel modes.

## IPv6 support matrix

| Protocol | Direct connection | SOCKS5 / HTTP CONNECT | Notes |
| --- | --- | --- | --- |
| FTP / FTPS | Supported by the control transport; passive mode recommended | Supported | Active mode depends on server/client EPRT support and inbound reachability. |
| SFTP | Supported | Supported | A single outbound SSH connection carries SFTP. |
| WebDAV | Supported with a bracketed IPv6 URL such as `https://[2001:db8::1]/dav` | Supported | Standard HTTP URL IPv6 syntax is required. |
| Any protocol via SOCKS4 | IPv4 or DNS target only | Not applicable | SOCKS4 has no IPv6 address type; choose SOCKS5 or HTTP CONNECT. |

Loopback regression tests (when IPv6 loopback is allowed by the host) cover direct TCP, SOCKS framing, HTTP CONNECT authority formatting,
FTP passive data connections, FTPS certificate rejection, and structured TLS/SSH/proxy errors.
Real NAT and firewall behavior remains environment-dependent; use the built-in proxy test and the
protocol log when validating a deployment network.

## Connection diagnostics

Connection errors keep detailed backend context in diagnostic data while the UI shows stable,
localized categories. Certificate validation, TLS negotiation, SSH negotiation, proxy failure,
authentication failure, timeout, refusal, and unreachable-network errors are distinguished. The
protocol log records the connection stage without logging passwords or proxy authorization data.
