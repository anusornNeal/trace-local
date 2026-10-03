package com.tracelocal.companion;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class PairingContractTest {
    @Test
    public void parsesIpv4ProxyAddress() {
        PairingContract.HostPort value = PairingContract.parseHostPort("192.168.1.20:8888");
        assertEquals("192.168.1.20", value.host);
        assertEquals(8888, value.port);
    }

    @Test
    public void parsesBracketedIpv6ProxyAddress() {
        PairingContract.HostPort value = PairingContract.parseHostPort("[fe80::1234]:4040");
        assertEquals("fe80::1234", value.host);
        assertEquals(4040, value.port);
    }

    @Test
    public void normalizesCertificateFingerprint() {
        assertEquals("AABBCCDD", PairingContract.normalizeFingerprint("aa:bb cc-dd"));
    }

    @Test
    public void detectsExpiredAuthorization() {
        PairingContract value = new PairingContract(
                "pairing", "desktop", "127.0.0.1", 8888,
                "AA", "http://127.0.0.1:4041", "http://127.0.0.1:4041/ca/token", 2000
        );
        assertFalse(value.isExpired(1999));
        assertTrue(value.isExpired(2000));
    }
}
