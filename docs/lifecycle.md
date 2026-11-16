# Tote lifecycle

Required sequence:

`inbound-ready -> product-linked -> outbound-ready -> in-transit -> received-for-packing -> offloaded-to-clean`

- POST /api/totes rejects with 409 if ANY unfinished cycle exists for that physical tote, regardless of product links. Historical closed cycles are preserved.
- Linking requires a product assignment and a non-blank destination, supplied explicitly or inherited from the assignment. Linking is allowed only before outbound.
- Outbound weight updates require product-linked or outbound-ready state, at least one product link, and a non-blank destination on EVERY link. Updating raw_kg also counts as outbound because it derives fish_kg.
- PATCH status enforces the sequence even when the caller supplies force. Product and destinations are checked for product-linked and subsequent states.
- POST complete only closes received-for-packing totes with product and destinations. It cannot be used to skip stages.
- Destination updates cannot clear the destination.
- Lifecycle writes run in a transaction and lock the physical tote inventory row, serializing concurrent requests for the same tote. HTTP success and station notifications follow commit.

Existing inconsistent records are not automatically repaired. In particular, an older unfinished cycle blocks reuse even if a more recent cycle is closed. Resolve such records with an audited operational decision; do not delete history or mark it complete merely to bypass the check.

Regression checks (Node.js with node:test support):

`node --test test/lifecycle.test.js`

Tests exercise route handlers with a simulated database; they do not mutate production data or replace MySQL concurrency testing.
