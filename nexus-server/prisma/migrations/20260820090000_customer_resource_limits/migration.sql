-- Trial & Resource Control (V.1.5): per-customer caps on user/workspace
-- counts. NULL = unlimited, so every existing customer keeps today's
-- unlimited behavior.
ALTER TABLE "customers" ADD COLUMN "maxUsers" INTEGER;
ALTER TABLE "customers" ADD COLUMN "maxWorkspaces" INTEGER;
