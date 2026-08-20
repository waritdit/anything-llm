const { EventLogs } = require("../models/eventLogs");
const { Invite } = require("../models/invite");
const { User } = require("../models/user");
const { Customer } = require("../models/customer");
const { reqBody } = require("../utils/http");
const {
  simpleSSOLoginDisabledMiddleware,
} = require("../utils/middleware/simpleSSOEnabled");

function inviteEndpoints(app) {
  if (!app) return;

  app.get("/invite/:code", async (request, response) => {
    try {
      const { code } = request.params;
      const invite = await Invite.get({ code });
      if (!invite) {
        response.status(200).json({ invite: null, error: "Invite not found." });
        return;
      }

      if (invite.status !== "pending") {
        response
          .status(200)
          .json({ invite: null, error: "Invite is no longer valid." });
        return;
      }

      response
        .status(200)
        .json({ invite: { code, status: invite.status }, error: null });
    } catch (e) {
      console.error(e);
      response.sendStatus(500).end();
    }
  });

  app.post(
    "/invite/:code",
    [simpleSSOLoginDisabledMiddleware],
    async (request, response) => {
      try {
        const { code } = request.params;
        const { username, password } = reqBody(request);
        const invite = await Invite.get({ code });
        if (!invite || invite.status !== "pending") {
          response
            .status(200)
            .json({ success: false, error: "Invite not found or is invalid." });
          return;
        }

        // Trial & Resource Control (V.1.5): self-registration via a
        // customer-scoped invite is another path into a capped customer,
        // so it needs the same maxUsers check as the admin-panel create path.
        if (invite.customer_id) {
          const customer = await Customer.get({ id: invite.customer_id });
          if (customer?.maxUsers) {
            const currentCount = await Customer.countUsers(customer.id);
            if (currentCount >= customer.maxUsers) {
              response.status(200).json({
                success: false,
                error: `This customer has reached its user limit (${customer.maxUsers}).`,
              });
              return;
            }
          }
        }

        // A customer-scoped invite (created by a Customer Admin) stamps its
        // customer onto the account it creates, so the new user's rows are
        // isolated the same way as everyone else provisioned under that
        // customer - see markClaimed() below for the matching workspaceIds
        // restriction.
        const { user, error } = await User.create({
          username,
          password,
          role: "default",
          customer_id: invite.customer_id || null,
        });
        if (!user) {
          console.error("Accepting invite:", error);
          response.status(200).json({ success: false, error });
          return;
        }

        await Invite.markClaimed(invite.id, user);
        await EventLogs.logEvent(
          "invite_accepted",
          {
            username: user.username,
          },
          user.id
        );

        response.status(200).json({ success: true, error: null });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );
}

module.exports = { inviteEndpoints };
