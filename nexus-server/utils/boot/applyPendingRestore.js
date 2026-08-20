const fs = require("fs");
const path = require("path");

/**
 * Must run as the very first thing index.js does - before Prisma, LanceDB,
 * or anything else touches storage. A backup restore (utils/backup) is
 * staged into `<storage>/.restore-staging` rather than applied live,
 * because overwriting files an already-running process has open (SQLite
 * connection pool, LanceDB file handles) risks corrupting the instance,
 * especially on Windows where file locks are stricter than Linux. Applying
 * the swap here instead - synchronously, at the top of a fresh process,
 * before anything has opened a handle on these files - is the safe order.
 */
module.exports = function applyPendingRestore() {
  const storageRoot =
    process.env.NODE_ENV === "development"
      ? path.resolve(__dirname, "../../storage")
      : path.resolve(process.env.STORAGE_DIR || "");
  const marker = path.resolve(storageRoot, ".restore-pending");
  const staging = path.resolve(storageRoot, ".restore-staging");
  if (!fs.existsSync(marker)) return;

  try {
    console.log(
      "\x1b[33m[Restore]\x1b[0m Pending restore detected - applying before boot..."
    );

    const stagedDb = path.join(staging, "anythingllm.db");
    if (fs.existsSync(stagedDb))
      fs.copyFileSync(stagedDb, path.join(storageRoot, "anythingllm.db"));

    for (const folder of ["documents", "lancedb", "vector-cache", "assets"]) {
      const src = path.join(staging, folder);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(storageRoot, folder);
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(src, dest, { recursive: true });
    }

    fs.rmSync(staging, { recursive: true, force: true });
    fs.unlinkSync(marker);
    console.log("\x1b[32m[Restore]\x1b[0m Restore applied successfully.");
  } catch (error) {
    // Deliberately does not delete the marker on failure - a corrupted or
    // half-applied restore should keep retrying (and keep logging loudly)
    // on every boot rather than silently falling through to boot normally
    // on top of a possibly-inconsistent state.
    console.error(
      "\x1b[31m[Restore]\x1b[0m Failed to apply pending restore:",
      error.message
    );
  }
};
