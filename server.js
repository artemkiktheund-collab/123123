import express from "express";
import crypto from "crypto";
import fs from "fs";
import dotenv from "dotenv";
import { Rcon } from "rcon-client";
import { status } from "minecraft-server-util";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const products = JSON.parse(fs.readFileSync("./products.json", "utf8"));

// Test orders are stored in memory.
// For real payments, use a database, because deploy/restart clears memory.
const orders = new Map();

app.use(express.json());
app.use(express.static("public"));

function validMinecraftNick(name) {
  return /^[a-zA-Z0-9_]{3,16}$/.test(name);
}

function createOrderId() {
  return crypto.randomBytes(12).toString("hex");
}

function getBaseUrl(req) {
  return process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
}

async function runMcCommand(command) {
  if (process.env.TEST_MODE === "true") {
    console.log("[TEST_MODE] Would run command:", command);
    return "TEST_MODE";
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

app.post("/api/create-order", async (req, res) => {
  const { product, nickname, currency = "UAH" } = req.body || {};
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

  // For now: styled internal payment page.
  // Later: replace paymentUrl with Stripe/PayPal checkout session URL.
  return res.json({
    orderId: id,
    paymentUrl: `/payment.html?order=${id}`
  });
});

app.get("/api/order/:id", (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });

  res.json({
    ...order,
    productName: products[order.product]?.name || order.productName
  });
});

app.post("/api/test-pay/:id", async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });

  if (order.status === "issued") {
    return res.json({ ok: true, order });
  }

  order.status = "paid";
  order.paidAt = new Date().toISOString();

  try {
    await issueProduct(order);
    res.json({ ok: true, order });
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

// Public status endpoint for website online placeholder.
// Works through normal Minecraft Server List Ping.
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
  console.log(`TEST_MODE=${process.env.TEST_MODE}`);
  console.log(`SERVER_HOST=${process.env.SERVER_HOST || "vanillasmp.space"}`);
  console.log(`SERVER_PORT=${process.env.SERVER_PORT || 25565}`);
});
