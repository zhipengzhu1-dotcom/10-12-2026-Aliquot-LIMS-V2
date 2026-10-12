"""Test Script: try a TCP connection to 1.1.1.1:53; exit 1 if it fails.

In the Sandbox (--network none) the connection must fail.
"""

import socket
import sys


def main() -> int:
    try:
        with socket.create_connection(("1.1.1.1", 53), timeout=5):
            print("connected to 1.1.1.1:53")
            return 0
    except OSError as error:
        print(f"no network: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
