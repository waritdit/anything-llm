const fs = require("fs");
const path = require("path");
const { Workspace } = require("./workspace");
const { WorkspaceUser } = require("./workspaceUsers");
const { WorkspaceChats } = require("./workspaceChats");
const {
  WorkspaceSuggestedMessages,
} = require("./workspacesSuggestedMessages");
const { User } = require("./user");
const { Document } = require("./documents");
const { DocumentVectors } = require("./vectors");
const { EventLogs } = require("./eventLogs");
const { hotdirPath, documentsPath } = require("../utils/files");
const { CollectorApi } = require("../utils/collectorApi");
const { getVectorDbClass } = require("../utils/helpers");

/**
 * Fixed, well-known content for the "Demo Environment" (V.1.5) - lets
 * Sales/Presales open a ready demo without prepping a fresh instance
 * beforehand. Distinct from Hosted Customer Trial: this is always
 * company-owned (customer_id: null), never assigned to an external customer.
 *
 * Every identifier below is fixed on purpose so seed()/reset() can find and
 * safely replace prior demo data without touching anything else on the
 * instance - a real customer could never collide with these names since
 * usernames/slugs are unique instance-wide.
 */
const DEMO_WORKSPACE_SLUG = "demo-workspace";
const DEMO_WORKSPACE_NAME = "Demo Workspace";
const DEMO_USER_PASSWORD = "NexusDemo2026!";
const DEMO_USERS = [{ username: "demo-sales" }, { username: "demo-guest" }];
const DEMO_DOCUMENTS = [
  {
    filename: "about-nexus-ai.txt",
    content:
      "Nexus AI (Zenwise AI) is an on-prem, private AI chat and knowledge-base " +
      "platform for Thai enterprises, built on NVIDIA DGX Spark. It lets a " +
      "company run its own AI assistant entirely on hardware it controls, " +
      "so sensitive documents and conversations never leave the organization. " +
      "Core capabilities: private multi-language chat, an enterprise knowledge " +
      "base with retrieval-augmented answers and source citations, and " +
      "workspace/user management with role-based access control.",
  },
  {
    filename: "dgx-spark-deployment.txt",
    content:
      "Nexus AI runs on NVIDIA DGX Spark, a compact on-prem AI system, so the " +
      "entire chat, embedding, and vector search pipeline stays inside the " +
      "customer's own network. A deployment is delivered as a ready-to-use " +
      "package: install, configure the LLM provider, and the instance is " +
      "immediately usable - no cloud dependency for inference or storage.",
  },
];
const DEMO_SUGGESTED_MESSAGES = [
  { heading: "Get started", message: "What can you help me with?" },
  {
    heading: "Summarize",
    message: "Summarize the key points from the demo documents.",
  },
  {
    heading: "Deployment",
    message: "How is Nexus AI deployed on NVIDIA DGX Spark?",
  },
];

const DemoContent = {
  isSeeded: async function () {
    return !!(await Workspace.get({ slug: DEMO_WORKSPACE_SLUG }));
  },

  /**
   * Writes each demo document into the collector's hotdir, waits for it to
   * be processed, then embeds it into the demo workspace. Best-effort - a
   * document processing failure (or the collector being offline) doesn't
   * fail the whole seed, since the workspace/users are still useful without it.
   */
  _seedDocuments: async function (workspace, userId) {
    const Collector = new CollectorApi();
    if (!(await Collector.online()))
      return {
        seeded: 0,
        skipped: DEMO_DOCUMENTS.length,
        reason: "Document processing API is not online.",
      };

    const existing = await Document.forWorkspace(workspace.id);
    const existingFilenames = existing.map((d) => d.filename);

    let seeded = 0;
    for (const doc of DEMO_DOCUMENTS) {
      // Already embedded from a prior seed() call - skip so re-running
      // seed() (or the "already seeded" case in reset()) stays idempotent
      // instead of piling up duplicate copies of the same demo document.
      if (existingFilenames.some((f) => f.startsWith(`${doc.filename}-`)))
        continue;

      try {
        fs.writeFileSync(
          path.join(hotdirPath, doc.filename),
          doc.content,
          "utf8"
        );
        const { success } = await Collector.processDocument(doc.filename);
        if (!success) continue;

        // processDocument doesn't return the resulting docpath - the
        // collector appends a UUID we can't predict, so find it by prefix.
        const customDocsDir = path.join(documentsPath, "custom-documents");
        const match = fs
          .readdirSync(customDocsDir)
          .find((f) => f.startsWith(`${doc.filename}-`) && f.endsWith(".json"));
        if (!match) continue;

        await Document.addDocuments(
          workspace,
          [`custom-documents/${match}`],
          userId
        );
        seeded++;
      } catch (error) {
        console.error(
          `DemoContent: failed to seed document ${doc.filename}`,
          error.message
        );
      }
    }
    return { seeded, skipped: DEMO_DOCUMENTS.length - seeded, reason: null };
  },

  /**
   * Idempotent - safe to call repeatedly. Creates whatever demo entities
   * don't already exist rather than erroring on the second call.
   */
  seed: async function (userId = null) {
    let workspace = await Workspace.get({ slug: DEMO_WORKSPACE_SLUG });
    if (!workspace) {
      const { workspace: created, message } = await Workspace.new(
        DEMO_WORKSPACE_NAME,
        userId,
        {},
        null
      );
      if (!created) return { success: false, error: message };
      workspace = created;
    }

    const users = [];
    for (const demoUser of DEMO_USERS) {
      let user = await User.get({ username: demoUser.username });
      if (!user) {
        const { user: created, error } = await User.create({
          username: demoUser.username,
          password: DEMO_USER_PASSWORD,
          role: "default",
        });
        if (!created) {
          console.error(
            `DemoContent: failed to create demo user ${demoUser.username}: ${error}`
          );
          continue;
        }
        user = created;
      }

      const membership = await WorkspaceUser.get({
        user_id: user.id,
        workspace_id: workspace.id,
      });
      if (!membership) await WorkspaceUser.create(user.id, workspace.id, "member");
      users.push(demoUser.username);
    }

    const documents = await this._seedDocuments(workspace, userId);
    await WorkspaceSuggestedMessages.saveAll(
      DEMO_SUGGESTED_MESSAGES,
      workspace.slug
    );

    await EventLogs.logEvent(
      "demo_content_seeded",
      { workspaceSlug: workspace.slug },
      userId
    );
    return {
      success: true,
      error: null,
      workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
      users,
      demoPassword: DEMO_USER_PASSWORD,
      documents,
    };
  },

  /**
   * Hard-deletes the demo workspace (chats, vectors, document rows) and
   * demo users, then re-seeds from scratch - "Reset to Clean Demo State"
   * from the master plan. Mirrors DELETE /workspace/:slug/purge's sequence.
   */
  reset: async function (userId = null) {
    const workspace = await Workspace.get({ slug: DEMO_WORKSPACE_SLUG });
    if (workspace) {
      const VectorDb = getVectorDbClass();
      await WorkspaceChats.delete({ workspaceId: Number(workspace.id) });
      await DocumentVectors.deleteForWorkspace(workspace.id);
      await Document.delete({ workspaceId: Number(workspace.id) });
      await Workspace.delete({ id: Number(workspace.id) });
      try {
        await VectorDb["delete-namespace"]({ namespace: workspace.slug });
      } catch (error) {
        console.error(error.message);
      }
    }

    for (const demoUser of DEMO_USERS) {
      const user = await User.get({ username: demoUser.username });
      if (user) await User.delete({ id: user.id });
    }

    await EventLogs.logEvent("demo_content_reset", {}, userId);
    return this.seed(userId);
  },
};

module.exports = { DemoContent, DEMO_WORKSPACE_SLUG };
