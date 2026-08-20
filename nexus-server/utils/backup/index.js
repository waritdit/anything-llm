const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const { documentsPath } = require("../files");

/**
 * Basic Backup/Restore (V.1.5, "Monitoring, Reset & Data Management").
 *
 * Backup is safe to run against a live instance - it only reads files.
 * Restore is intentionally NOT applied live: extracting a backup over
 * files Prisma/LanceDB currently have open (especially on Windows, where
 * file locks are stricter than Linux) risks corrupting the running
 * instance. Instead, stageRestore() extracts the archive into a staging
 * folder and drops a marker file; the actual swap happens the next time the
 * process boots, in utils/boot/applyPendingRestore.js, which runs before
 * anything opens the database - see that file for why this order matters.
 */

// documentsPath is `<storage>/documents` in both dev and prod (see
// utils/files/index.js) - going up one level gives the storage root without
// this module needing its own NODE_ENV branching.
const storageRoot = path.resolve(documentsPath, "..");
const dbFilePath = path.resolve(storageRoot, "anythingllm.db");
const BACKUP_DIRS = ["documents", "lancedb", "vector-cache", "assets"];
const backupsFolder = path.resolve(storageRoot, "backups");
const restoreStagingFolder = path.resolve(storageRoot, ".restore-staging");
const restoreMarkerFile = path.resolve(storageRoot, ".restore-pending");

function resolveBackupPath(filename) {
  // basename() strips any directory component, so this can't escape
  // backupsFolder regardless of what the caller passes in.
  const safeName = path.basename(String(filename || ""));
  if (!safeName.endsWith(".zip")) return null;
  return path.resolve(backupsFolder, safeName);
}

const Backup = {
  list: function () {
    if (!fs.existsSync(backupsFolder)) return [];
    return fs
      .readdirSync(backupsFolder)
      .filter((f) => f.endsWith(".zip"))
      .map((filename) => {
        const stat = fs.statSync(path.join(backupsFolder, filename));
        return { filename, sizeBytes: stat.size, createdAt: stat.birthtime };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  },

  create: function () {
    if (!fs.existsSync(backupsFolder))
      fs.mkdirSync(backupsFolder, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `nexus-ai-backup-${timestamp}.zip`;
    const zip = new AdmZip();

    if (fs.existsSync(dbFilePath)) zip.addLocalFile(dbFilePath);
    for (const folder of BACKUP_DIRS) {
      const fullPath = path.resolve(storageRoot, folder);
      if (fs.existsSync(fullPath)) zip.addLocalFolder(fullPath, folder);
    }

    const outPath = path.join(backupsFolder, filename);
    zip.writeZip(outPath);
    const stat = fs.statSync(outPath);
    return { filename, sizeBytes: stat.size, createdAt: stat.birthtime };
  },

  delete: function (filename) {
    const target = resolveBackupPath(filename);
    if (!target || !fs.existsSync(target)) return false;
    fs.unlinkSync(target);
    return true;
  },

  downloadPath: function (filename) {
    const target = resolveBackupPath(filename);
    return target && fs.existsSync(target) ? target : null;
  },

  /**
   * Extracts the named backup into the staging folder and drops the marker
   * file that utils/boot/applyPendingRestore.js looks for on next boot.
   * Does NOT touch live data. The caller must restart the process
   * afterward for the restore to actually take effect.
   */
  stageRestore: function (filename) {
    const source = resolveBackupPath(filename);
    if (!source || !fs.existsSync(source))
      return { success: false, error: "Backup file not found." };

    if (fs.existsSync(restoreStagingFolder))
      fs.rmSync(restoreStagingFolder, { recursive: true, force: true });
    fs.mkdirSync(restoreStagingFolder, { recursive: true });

    const zip = new AdmZip(source);
    zip.extractAllTo(restoreStagingFolder, true);
    fs.writeFileSync(restoreMarkerFile, source, "utf8");
    return { success: true, error: null };
  },

  pendingRestore: function () {
    return fs.existsSync(restoreMarkerFile) ? fs.readFileSync(restoreMarkerFile, "utf8") : null;
  },

  cancelPendingRestore: function () {
    if (fs.existsSync(restoreMarkerFile)) fs.unlinkSync(restoreMarkerFile);
    if (fs.existsSync(restoreStagingFolder))
      fs.rmSync(restoreStagingFolder, { recursive: true, force: true });
  },
};

module.exports = {
  Backup,
  storageRoot,
  dbFilePath,
  BACKUP_DIRS,
  restoreStagingFolder,
  restoreMarkerFile,
};
