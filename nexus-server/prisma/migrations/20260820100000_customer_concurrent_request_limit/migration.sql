-- Trial & Resource Control (V.1.5): caps how many chat requests a customer's
-- workspaces may have in flight at once, protecting the shared DGX Spark GPU
-- from one trial customer starving every other tenant. NULL = unlimited.
ALTER TABLE "customers" ADD COLUMN "maxConcurrentRequests" INTEGER;
