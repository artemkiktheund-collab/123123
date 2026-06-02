import express from "express";
import crypto from "crypto";
import fs from "fs";
import dotenv from "dotenv";
import { Rcon } from "rcon-client";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const products = JSON.parse(fs.readFileSync("./products.json", "utf8"));

// In real production use a database.
// This is enough for the first test build.
const orders = new Map();

app.use(express.json());
app.use(express.static("public"));

function validMinecraftNick(name) {
  return /^[a-zA-Z0-9_]{3,16}$/.test(name);
}

function createOrderId() {
  return crypto.randomBytes(12).toString("hex");
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

app.post("/api/create-order", (req, res) => {
  const { product, nickname } = req.body || {};

  if (!products[product]) {
    return res.status(400).json({ error: "Unknown product." });
  }

  if (!validMinecraftNick(nickname)) {
    return res.status(400).json({ error: "Invalid Minecraft nickname." });
  }

  const id = createOrderId();
  const order = {
    id,
    product,
    nickname,
    price: products[product].price,
    status: "created",
    createdAt: new Date().toISOString()
  };

  orders.set(id, order);

  // TEST CHECKOUT.
  // Later replace this with Stripe/PayPal/Przelewy24/PayU payment URL.
  const paymentUrl = `/checkout-test.html?order=${id}`;

  res.json({ orderId: id, paymentUrl });
});

app.get("/api/order/:id", (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });

  res.json({
    ...order,
    productName: products[order.product]?.name
  });
});

// This imitates successful payment.
// In production this route must be replaced by a real payment webhook.
app.post("/api/test-pay/:id", async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });

  if (order.status === "issued") {
    return res.json({ ok: true, status: "already issued" });
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
    res.status(500).json({ error: "Payment accepted, but issue failed.", details: order.error });
  }
});

app.listen(PORT, () => {
  console.log(`VanillaSMP Store running on http://localhost:${PORT}`);
  console.log(`TEST_MODE=${process.env.TEST_MODE}`);
});
