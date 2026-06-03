import express from "express";
import crypto from "crypto";
import fs from "fs";
import dotenv from "dotenv";
import Stripe from "stripe";
import { Rcon } from "rcon-client";
import { status } from "minecraft-server-util";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const products = JSON.parse(fs.readFileSync("./products.json", "utf8"));

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// Orders are kept in memory for the current runtime.
// Stripe webhook also stores product/nickname in metadata, so issuing can still work if the memory order is missing.
const orders = new Map();

function validMinecraftNick(name) {
  return /^[a-zA-Z0-9_]{3,16}$/.test(name);
}

function createOrderId() {
  return crypto.randomBytes(12).toString("hex");
}

function getBaseUrl(req) {
  return process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
}

function stripeAmount(price) {
  return Math.round(Number(price) * 100);
}

function normalizeCurrency(currency) {
  return String(currency || "USD").toLowerCase();
}

async function runMcCommand(command) {
  if (process.env.RCON_ENABLED !== "true") {
    console.log("[RCON_DISABLED] Would run command:", command);
    return "RCON_DISABLED";
  }

  const rcon = await Rcon.connect({
    host: process.env.RCON_HOST || "127.0.0.1",
    port: Number(process.env.RCON_PORT || 25575),
    password: process.env.RCON_PASSWORD
  });

  try {
    const response = await rcon.send(command);
    console.log("[RCON]", command, "=>", response);
    return response;
  } finally {
    await rcon.end();
  }
}

async function issueProduct(order) {
  const product = products[order.product];
  if (!product) throw new Error("Unknown product");

  for (const template of product.commands) {
    const command = template.replaceAll("{player}", order.nickname);
    await runMcCommand(command);
  }

  order.status = "issued";
  order.issuedAt = new Date().toISOString();
}

function publicOrder(order) {
  return {
    id: order.id,
    product: order.product,
    productName: products[order.product]?.name || order.productName || order.product,
    nickname: order.nickname,
    currency: order.currency,
    price: order.price,
    status: order.status,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    issuedAt: order.issuedAt
  };
}

// IMPORTANT: Stripe webhook must be BEFORE express.json().
app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).send("Stripe webhook is not configured.");
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("[STRIPE_WEBHOOK_SIGNATURE_ERROR]", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const meta = session.metadata || {};

      const orderId = meta.orderId;
      let order = orders.get(orderId);

      // Fallback if server restarted after Checkout Session creation.
      if (!order) {
        order = {
          id: orderId || createOrderId(),
          product: meta.product,
          productName: products[meta.product]?.name || meta.product,
          nickname: meta.nickname,
          currency: String(session.currency || meta.currency || "USD").toUpperCase(),
          price: Number(meta.price || 0),
          status: "created",
          createdAt: new Date().toISOString()
        };
        orders.set(order.id, order);
      }

      order.status = "paid";
      order.paidAt = new Date().toISOString();
      order.stripeSessionId = session.id;
      order.stripePaymentStatus = session.payment_status;

      await issueProduct(order);
      console.log("[PAYMENT_ISSUED]", publicOrder(order));
    }

    res.json({ received: true });
  } catch (err) {
    console.error("[STRIPE_WEBHOOK_ISSUE_ERROR]", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.use(express.json());
app.use(express.static("public"));

app.post("/api/create-order", async (req, res) => {
  const { product, nickname, currency = "USD" } = req.body || {};
  const allowedCurrencies = ["UAH", "RUB", "USD"];

  if (!products[product]) {
    return res.status(400).json({ error: "Unknown product." });
  }

  if (!allowedCurrencies.includes(currency)) {
    return res.status(400).json({ error: "Unknown currency." });
  }

  if (!validMinecraftNick(nickname)) {
    return res.status(400).json({ error: "Invalid Minecraft nickname." });
  }

  const selectedProduct = products[product];
  const price = selectedProduct.prices?.[currency];

  if (typeof price !== "number") {
    return res.status(400).json({ error: "Price is not configured for this currency." });
  }

  const id = createOrderId();
  const order = {
    id,
    product,
    productName: selectedProduct.name,
    nickname,
    currency,
    price,
    status: "created",
    createdAt: new Date().toISOString()
  };

  orders.set(id, order);

  return res.json({
    orderId: id,
    paymentUrl: `/payment.html?order=${id}`
  });
});

app.get("/api/order/:id", (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  res.json(publicOrder(order));
});

app.post("/api/start-payment/:id", async (req, res) => {
  if (!stripe) {
    return res.status(500).json({
      error: "Stripe is not configured. Add STRIPE_SECRET_KEY in Render Environment."
    });
  }

  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });

  const product = products[order.product];
  if (!product) return res.status(400).json({ error: "Unknown product." });

  const baseUrl = getBaseUrl(req);

  // Charge in USD for maximum compatibility.
  // The website can still display local prices, but Stripe Checkout processes the payment in USD.
  const stripeCurrency = String(process.env.STRIPE_CHARGE_CURRENCY || "USD").toUpperCase();
  const stripePrice = product.prices?.[stripeCurrency] ?? product.prices?.USD ?? order.price;
  const amount = stripeAmount(stripePrice);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: stripeCurrency.toLowerCase(),
            unit_amount: amount,
            product_data: {
              name: product.name,
              description: `Minecraft nickname: ${order.nickname}`
            }
          }
        }
      ],
      metadata: {
        orderId: order.id,
        product: order.product,
        nickname: order.nickname,
        currency: order.currency,
        price: String(order.price),
        stripeCurrency,
        stripePrice: String(stripePrice)
      },
      success_url: `${baseUrl}/payment-success.html?order=${order.id}`,
      cancel_url: `${baseUrl}/payment-cancel.html?order=${order.id}`
    });

    order.status = "checkout_created";
    order.stripeSessionId = session.id;
    order.checkoutCreatedAt = new Date().toISOString();

    return res.json({ url: session.url });
  } catch (err) {
    console.error("[STRIPE_CREATE_SESSION_ERROR]", err);
    return res.status(500).json({
      error: err.message || "Could not create payment session.",
      code: err.code || null,
      type: err.type || null
    });
  }
});

// Internal dry-run endpoint, disabled by default.
app.post("/api/test-pay/:id", async (req, res) => {
  if (process.env.ENABLE_TEST_PAY !== "true") {
    return res.status(403).json({ error: "Test payment endpoint is disabled." });
  }

  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });

  if (order.status === "issued") {
    return res.json({ ok: true, order: publicOrder(order) });
  }

  order.status = "paid";
  order.paidAt = new Date().toISOString();

  try {
    await issueProduct(order);
    res.json({ ok: true, order: publicOrder(order) });
  } catch (err) {
    order.status = "paid_but_issue_failed";
    order.error = String(err.message || err);
    console.error(err);
    res.status(500).json({
      error: "Payment accepted, but issue failed.",
      details: order.error
    });
  }
});

app.get("/api/server-status", async (req, res) => {
  const host = process.env.SERVER_HOST || "vanillasmp.space";
  const port = Number(process.env.SERVER_PORT || 25565);

  try {
    const result = await status(host, port, {
      timeout: 5000,
      enableSRV: true
    });

    res.json({
      online: true,
      host,
      port,
      version: result.version?.name || null,
      playersOnline: result.players?.online ?? 0,
      playersMax: result.players?.max ?? 0,
      motd: result.motd?.clean || null
    });
  } catch (err) {
    res.json({
      online: false,
      host,
      port,
      error: "Server is offline or status ping is blocked."
    });
  }
});

app.listen(PORT, () => {
  console.log(`VanillaSMP Store running on http://localhost:${PORT}`);
  console.log(`PUBLIC_URL=${process.env.PUBLIC_URL || "not set"}`);
  console.log(`RCON_ENABLED=${process.env.RCON_ENABLED || "false"}`);
  console.log(`STRIPE=${stripe ? "configured" : "not configured"}`);
});
