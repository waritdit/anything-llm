/**
 * In-flight chat-request counter per customer (Trial & Resource Control,
 * V.1.5) - guards `customers.maxConcurrentRequests`. Deliberately a plain
 * in-memory Map, not a DB table or Redis: this app runs as a single Node
 * process per deployment (the DGX Spark target), so there is exactly one
 * counter that matters and no cross-process state to reconcile. A restart
 * resets every count to zero, which is the correct behavior - any request
 * that was "in flight" died with the old process anyway.
 */
const inFlightByCustomer = new Map();

/**
 * Attempts to reserve one in-flight slot for a customer. Returns false
 * without reserving anything if the customer is already at its limit.
 * @param {number} customerId
 * @param {number|null} limit - customers.maxConcurrentRequests; null/0 = unlimited
 * @returns {boolean}
 */
function acquire(customerId, limit) {
  if (!customerId || !limit) return true;
  const current = inFlightByCustomer.get(customerId) || 0;
  if (current >= limit) return false;
  inFlightByCustomer.set(customerId, current + 1);
  return true;
}

/**
 * Releases a previously-acquired slot. Safe to call even if acquire()
 * returned true for an unlimited customer (customerId untouched, no-op) or
 * was never called for this customerId (floors at 0, never goes negative).
 * @param {number} customerId
 */
function release(customerId) {
  if (!customerId) return;
  const current = inFlightByCustomer.get(customerId) || 0;
  if (current <= 1) inFlightByCustomer.delete(customerId);
  else inFlightByCustomer.set(customerId, current - 1);
}

/** Test/debug helper - current in-flight count for a customer. */
function currentCount(customerId) {
  return inFlightByCustomer.get(customerId) || 0;
}

module.exports = { acquire, release, currentCount };
