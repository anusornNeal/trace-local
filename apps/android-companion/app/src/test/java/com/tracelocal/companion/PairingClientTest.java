package com.tracelocal.companion;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public final class PairingClientTest {
    @Test public void sessionIdsAreEncodedAsOneUtf8PathSegment() throws Exception {
        assertEquals("id%20%2F%2B%3F%23%25", PairingClient.urlSegment("id /+?#%"));
        assertEquals("%E0%B9%84%E0%B8%97%E0%B8%A2", PairingClient.urlSegment("ไทย"));
        assertEquals("session-123", PairingClient.urlSegment("session-123"));
    }
}
