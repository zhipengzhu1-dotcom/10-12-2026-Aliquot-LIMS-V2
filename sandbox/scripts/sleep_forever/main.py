"""Test Script: never finishes, so the Sandbox time limit must kill it."""

import time

if __name__ == "__main__":
    print("sleeping forever", flush=True)
    while True:
        time.sleep(60)
