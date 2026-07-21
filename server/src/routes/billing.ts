import { Router, raw } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireOrgRole } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest, notFound } from "../lib/errors.js";
import { config } from "../lib/config.js";
import { logAudit } from "../services/audit.js";

export const billingRouter = Router();
export const stripeWebhookRouter = Router();

const STRIPE_API = "https://api.stripe.com/v1";

function stripeConfigured() {
  return Boolean(config.stripe.secretKey);
}

/** Minimal Stripe REST client — form-encoded, no SDK needed for the calls we make. */
async function stripeRequest(path: string, params: Record<string, string>) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.stripe.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json()) as Record<string, unknown> & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${data.error?.message ?? path}`);
  return data;
}

/**
 * Tells the frontend which billing mode this server is in. When Stripe isn't
 * configured the UI offers direct plan switching instead of checkout.
 */
billingRouter.get("/billing/config", requireAuth, (_req, res) => {
  res.json({ stripeConfigured: stripeConfigured(), selfServePlans: !stripeConfigured() });
});

const planSwitchSchema = z.object({ plan: z.enum(["free", "pro", "team"]) });

/**
 * Development-mode plan switching — lets an owner move between tiers without a
 * Stripe subscription so each tier's behavior can actually be exercised
 * end-to-end before billing is wired up.
 *
 * Deliberately NOT a limit bypass. `PLANS` keeps its real per-tier limits
 * (services/plans.ts, guarded by test/plan-limits.ts); only the *payment*
 * barrier is removed, so switching to `free` really does enforce free-tier
 * limits. This is the distinction from the 2026-07-20 change that gave every
 * tier team-level limits and had to be reverted — see docs/decisions.md.
 *
 * The gate is `!stripeConfigured()`, so this route disables itself the moment
 * STRIPE_SECRET_KEY is set. There is no flag to forget to flip.
 */
billingRouter.post(
  "/orgs/:orgId/billing/plan",
  requireAuth,
  requireOrgRole("owner"),
  validateBody(planSwitchSchema),
  async (req, res, next) => {
    try {
      if (stripeConfigured())
        return res.status(409).json({
          error: "Billing is configured on this server — use checkout to change plans.",
        });
      const { plan } = req.body as z.infer<typeof planSwitchSchema>;
      const org = await queryOne<{ id: string }>(
        "SELECT id FROM organizations WHERE id = $1",
        [req.params.orgId],
      );
      if (!org) throw notFound();

      await query(
        `UPDATE organizations SET plan = $2, plan_status = 'active',
           stripe_subscription_id = NULL WHERE id = $1`,
        [org.id, plan],
      );
      await logAudit(org.id, req.user!.id, "billing.plan_switched_devmode", plan);
      res.json({ plan });
    } catch (err) {
      next(err);
    }
  },
);

const checkoutSchema = z.object({ plan: z.enum(["pro", "team"]) });

billingRouter.post(
  "/orgs/:orgId/billing/checkout",
  requireAuth,
  requireOrgRole("owner"),
  validateBody(checkoutSchema),
  async (req, res, next) => {
    try {
      if (!stripeConfigured())
        return res
          .status(501)
          .json({ error: "Billing is not configured on this server (set STRIPE_SECRET_KEY)" });
      const { plan } = req.body as z.infer<typeof checkoutSchema>;
      const price = plan === "pro" ? config.stripe.pricePro : config.stripe.priceTeam;
      if (!price) throw badRequest(`No Stripe price configured for the ${plan} plan`);

      const org = await queryOne<{ id: string; stripe_customer_id: string | null }>(
        "SELECT id, stripe_customer_id FROM organizations WHERE id = $1",
        [req.params.orgId],
      );
      if (!org) throw notFound();

      let customerId = org.stripe_customer_id;
      if (!customerId) {
        const customer = await stripeRequest("/customers", {
          email: req.user!.email,
          "metadata[org_id]": org.id,
        });
        customerId = customer.id as string;
        await query("UPDATE organizations SET stripe_customer_id = $2 WHERE id = $1", [
          org.id,
          customerId,
        ]);
      }

      const session = await stripeRequest("/checkout/sessions", {
        mode: "subscription",
        customer: customerId,
        "line_items[0][price]": price,
        "line_items[0][quantity]": "1",
        success_url: `${config.appUrl}/orgs/${org.id}/billing?upgraded=1`,
        cancel_url: `${config.appUrl}/orgs/${org.id}/billing`,
        "metadata[org_id]": org.id,
        "metadata[plan]": plan,
        "subscription_data[metadata][org_id]": org.id,
        "subscription_data[metadata][plan]": plan,
      });
      await logAudit(org.id, req.user!.id, "billing.checkout_started", plan);
      res.json({ url: session.url });
    } catch (err) {
      next(err);
    }
  },
);

billingRouter.post(
  "/orgs/:orgId/billing/portal",
  requireAuth,
  requireOrgRole("owner"),
  async (req, res, next) => {
    try {
      if (!stripeConfigured())
        return res.status(501).json({ error: "Billing is not configured on this server" });
      const org = await queryOne<{ stripe_customer_id: string | null }>(
        "SELECT stripe_customer_id FROM organizations WHERE id = $1",
        [req.params.orgId],
      );
      if (!org?.stripe_customer_id) throw badRequest("No billing account yet — upgrade first");
      const session = await stripeRequest("/billing_portal/sessions", {
        customer: org.stripe_customer_id,
        return_url: `${config.appUrl}/orgs/${req.params.orgId}/billing`,
      });
      res.json({ url: session.url });
    } catch (err) {
      next(err);
    }
  },
);

// ---- Stripe webhook (raw body, signature-verified) ----

function verifyStripeSignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!config.stripe.webhookSecret || !header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((kv) => kv.split("=") as [string, string]),
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false; // replay guard
  const expected = crypto
    .createHmac("sha256", config.stripe.webhookSecret)
    .update(`${timestamp}.${rawBody.toString("utf8")}`)
    .digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

stripeWebhookRouter.post("/stripe", raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  if (!verifyStripeSignature(req.body as Buffer, req.headers["stripe-signature"] as string)) {
    return res.status(401).json({ error: "Invalid signature" });
  }
  let event: { type: string; data: { object: Record<string, unknown> } };
  try {
    event = JSON.parse((req.body as Buffer).toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  try {
    const obj = event.data.object;
    switch (event.type) {
      case "checkout.session.completed": {
        const orgId = (obj.metadata as Record<string, string> | null)?.org_id;
        const plan = (obj.metadata as Record<string, string> | null)?.plan;
        if (orgId && plan) {
          await query(
            `UPDATE organizations SET plan = $2, plan_status = 'active',
               stripe_subscription_id = $3 WHERE id = $1`,
            [orgId, plan, (obj.subscription as string) ?? null],
          );
          await logAudit(orgId, null, "billing.plan_activated", plan);
        }
        break;
      }
      case "customer.subscription.updated": {
        const orgId = (obj.metadata as Record<string, string> | null)?.org_id;
        if (orgId) {
          const status = obj.status as string;
          await query("UPDATE organizations SET plan_status = $2 WHERE id = $1", [
            orgId,
            status === "active" || status === "trialing" ? "active" : "past_due",
          ]);
        }
        break;
      }
      case "customer.subscription.deleted": {
        const orgId = (obj.metadata as Record<string, string> | null)?.org_id;
        if (orgId) {
          await query(
            `UPDATE organizations SET plan = 'free', plan_status = 'active',
               stripe_subscription_id = NULL WHERE id = $1`,
            [orgId],
          );
          await logAudit(orgId, null, "billing.plan_canceled");
        }
        break;
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error("stripe webhook failed", err);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});
