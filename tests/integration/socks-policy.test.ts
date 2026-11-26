/**
 * Tests du filtre SOCKS5 (src/vpn/socks-policy.ts).
 *
 * Le sidecar refuse tout CONNECT vers une destination non-routable :
 * loopback, link-local (dont les métadonnées cloud 169.254.169.254),
 * privé, CGNAT, multicast/réservé, documentation, et leurs équivalents
 * IPv6 (dont les adresses IPv4-mappées ::ffff:a.b.c.d). Les IP publiques
 * restent autorisées — seul le trafic YouTube doit passer.
 *
 * Category: integration — adapter boundary (vpn), pure function, no I/O.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasBlockedAddress, isBlockedIp, parseSocksLimits } from '../../src/vpn/socks-policy.ts';

describe('socks-policy — isBlockedIp', () => {
  it('blocks IPv4 loopback, link-local, private, CGNAT and metadata', () => {
    const blocked = [
      '127.0.0.1',
      '127.0.0.53',
      '169.254.169.254', // métadonnées cloud (AWS/GCP/Azure)
      '169.254.1.1',
      '10.0.0.1',
      '10.64.0.1', // DNS Mullvad : jamais une destination CONNECT
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1', // CGNAT (dont le range Tailscale)
      '100.127.255.255',
      '0.0.0.0',
      '0.1.2.3',
    ];
    for (const ip of blocked) {
      assert.equal(isBlockedIp(ip), true, `ip=${ip} must be blocked (non-routable/private/metadata)`);
    }
  });

  it('blocks IPv4 multicast, reserved, broadcast and documentation ranges', () => {
    const blocked = [
      '224.0.0.1',
      '239.255.255.255',
      '240.0.0.1',
      '255.255.255.255',
      '192.0.2.1',
      '198.51.100.1',
      '203.0.113.1',
      '198.18.0.1',
    ];
    for (const ip of blocked) {
      assert.equal(isBlockedIp(ip), true, `ip=${ip} must be blocked (multicast/reserved/documentation)`);
    }
  });

  it('blocks IPv6 loopback, link-local, ULA/metadata, multicast and unspecified', () => {
    const blocked = [
      '::1',
      '::',
      'fe80::1',
      'fe80::a9fe:a9fe', // forme compressée de 169.254.169.254 en IPv6
      'fc00::1',
      'fd00:ec2::254', // métadonnées IPv6 AWS
      'fd12:3456::1',
      'ff02::1',
      'fec0::1',
      '2001:db8::1',
      '100::1',
    ];
    for (const ip of blocked) {
      assert.equal(isBlockedIp(ip), true, `ip=${ip} must be blocked (IPv6 non-routable/private/metadata)`);
    }
  });

  it('blocks IPv4-mapped IPv6 by the embedded IPv4 address', () => {
    assert.equal(isBlockedIp('::ffff:127.0.0.1'), true, 'ip=::ffff:127.0.0.1 must be blocked via embedded loopback');
    assert.equal(
      isBlockedIp('::ffff:169.254.169.254'),
      true,
      'ip=::ffff:169.254.169.254 must be blocked via embedded metadata',
    );
    assert.equal(isBlockedIp('::ffff:10.0.0.5'), true, 'ip=::ffff:10.0.0.5 must be blocked via embedded private');
    assert.equal(
      isBlockedIp('::ffff:93.184.216.34'),
      false,
      'ip=::ffff:93.184.216.34 must be allowed via embedded public',
    );
  });

  it('allows public IPv4 and IPv6 destinations', () => {
    const allowed = [
      '93.184.216.34',
      '8.8.8.8',
      '1.1.1.1',
      '172.32.0.1',
      '172.15.0.1',
      '100.128.0.1',
      '100.63.0.1',
      '192.169.0.1',
      '192.167.0.1',
      '2606:4700:4700::1111',
      '2607:f8b0:4004:800::200e',
    ];
    for (const ip of allowed) {
      assert.equal(isBlockedIp(ip), false, `ip=${ip} must be allowed (public)`);
    }
  });

  it('parseSocksLimits returns bounded defaults when unset or invalid', () => {
    assert.deepEqual(parseSocksLimits({}), {
      maxConnections: 32,
      connectTimeoutMs: 10_000,
      idleTimeoutMs: 60_000,
      dnsTimeoutMs: 5_000,
    });
    assert.deepEqual(
      parseSocksLimits({
        SOCKS_MAX_CONNECTIONS: 'abc',
        SOCKS_CONNECT_TIMEOUT_MS: '',
        SOCKS_IDLE_TIMEOUT_MS: '1.5',
        SOCKS_DNS_TIMEOUT_MS: 'nope',
      }),
      { maxConnections: 32, connectTimeoutMs: 10_000, idleTimeoutMs: 60_000, dnsTimeoutMs: 5_000 },
      'non-numeric env values must fall back to defaults',
    );
  });

  it('parseSocksLimits honours valid env overrides', () => {
    assert.deepEqual(
      parseSocksLimits({
        SOCKS_MAX_CONNECTIONS: '8',
        SOCKS_CONNECT_TIMEOUT_MS: '2000',
        SOCKS_IDLE_TIMEOUT_MS: '30000',
        SOCKS_DNS_TIMEOUT_MS: '1234',
      }),
      { maxConnections: 8, connectTimeoutMs: 2000, idleTimeoutMs: 30_000, dnsTimeoutMs: 1234 },
    );
  });

  it('parseSocksLimits clamps out-of-range values to the bound (N passes, N+1 clamps)', () => {
    assert.equal(
      parseSocksLimits({ SOCKS_MAX_CONNECTIONS: '256' }).maxConnections,
      256,
      'maxConnections=256 (bound) must pass',
    );
    assert.equal(
      parseSocksLimits({ SOCKS_MAX_CONNECTIONS: '257' }).maxConnections,
      256,
      'maxConnections=257 must clamp to 256',
    );
    assert.equal(
      parseSocksLimits({ SOCKS_MAX_CONNECTIONS: '0' }).maxConnections,
      1,
      'maxConnections=0 must clamp to 1',
    );
    assert.equal(
      parseSocksLimits({ SOCKS_CONNECT_TIMEOUT_MS: '99' }).connectTimeoutMs,
      100,
      'connectTimeoutMs=99 must clamp to 100',
    );
    assert.equal(
      parseSocksLimits({ SOCKS_CONNECT_TIMEOUT_MS: '60001' }).connectTimeoutMs,
      60_000,
      'connectTimeoutMs=60001 must clamp to 60000',
    );
    assert.equal(
      parseSocksLimits({ SOCKS_IDLE_TIMEOUT_MS: '999' }).idleTimeoutMs,
      1000,
      'idleTimeoutMs=999 must clamp to 1000',
    );
    assert.equal(
      parseSocksLimits({ SOCKS_IDLE_TIMEOUT_MS: '600001' }).idleTimeoutMs,
      600_000,
      'idleTimeoutMs=600001 must clamp to 600000',
    );
    assert.equal(
      parseSocksLimits({ SOCKS_DNS_TIMEOUT_MS: '30001' }).dnsTimeoutMs,
      30_000,
      'dnsTimeoutMs=30001 must clamp to 30000',
    );
  });

  it('hasBlockedAddress blocks a hostname if any A record is blocked', () => {
    assert.equal(hasBlockedAddress(['93.184.216.34', '8.8.8.8']), false, 'all-public A records must be allowed');
    assert.equal(
      hasBlockedAddress(['93.184.216.34', '10.0.0.1']),
      true,
      'mixed public+private A records must be blocked',
    );
    assert.equal(
      hasBlockedAddress(['169.254.169.254', '93.184.216.34']),
      true,
      'metadata first A record must be blocked',
    );
    assert.equal(hasBlockedAddress(['127.0.0.1']), true, 'single loopback A record must be blocked');
  });

  it('fails closed on invalid input', () => {
    for (const ip of ['', 'not-an-ip', '999.1.1.1', '127.1', '::ffff:999.1.1.1']) {
      assert.equal(isBlockedIp(ip), true, `ip=${JSON.stringify(ip)} must fail closed (invalid)`);
    }
  });
});
