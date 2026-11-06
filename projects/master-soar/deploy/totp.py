"""Print the current sign-in code for a Master SOAR account.

For when you have not put the secret in an authenticator app yet - or do not
want to. Same algorithm the platform verifies with (RFC 6238, SHA-1, 6 digits,
30-second step), so the code this prints is the code it expects.

    python totp.py                     the SOC Lead account
    python totp.py <BASE32-SECRET>     any other account

The secret is the one create-admin printed once. Losing it means enrolling a new
factor, not recovering the old one.
"""
import base64
import hashlib
import hmac
import struct
import sys
import time

# Printed by: docker compose run --rm api python -m soar.main create-admin
DEFAULT = "V654VU5CQIMM2Z4REGMCPXV2CKZNZHI4"


def code(secret_b32: str, when: float) -> str:
    key = base64.b32decode(secret_b32 + "=" * (-len(secret_b32) % 8), casefold=True)
    counter = int(when) // 30
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return "%06d" % (value % 1000000)


secret = (sys.argv[1] if len(sys.argv) > 1 else DEFAULT).replace(" ", "").upper()
now = time.time()
remaining = 30 - int(now) % 30

print()
print("    code:  %s" % code(secret, now))
print("    valid: %d second%s" % (remaining, "" if remaining == 1 else "s"))
if remaining < 8:
    print("    next:  %s  (use this one if the first is refused)"
          % code(secret, now + 30))
print()
