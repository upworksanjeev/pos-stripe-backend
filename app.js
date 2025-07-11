const express = require("express");

const cors = require("cors");
const app = express();
const { resolve } = require("path");
require("dotenv").config();

// // ✅ Wrap Stripe init in try-catch to catch key errors
let stripe;
try {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
} catch (err) {
  console.error("Stripe init failed:", err.message);
}

app.use(cors());

app.use((req, res, next) => {
  let data = "";
  req.on("data", (chunk) => {
    data += chunk;
  });
  req.on("end", () => {
    try {
      req.body = JSON.parse(data);
    } catch (err) {
      req.body = {};
    }
    next();
  });
});

app.use(express.static("public"));

app.get("/test", (req, res) => {
  res.send("Deployed");
});

// Create a new connection token (used by frontend Terminal SDK)
app.post("/api/connection-token", async (req, res) => {
  const token = await stripe.terminal.connectionTokens.create();
  res.json({ secret: token.secret });
});

// Register a reader to a location
app.post("/api/register-reader", async (req, res) => {
  const reader = await stripe.terminal.readers.create({
    registration_code: req.body.registration_code,
    location: req.body.location_id,
  });
  res.json(reader);
});

// Create a location (one-time use, mainly for setup)
app.post("/api/create-location", async (req, res) => {
  if (
    !req.body.label ||
    !req.body.line1 ||
    !req.body.city ||
    !req.body.state ||
    !req.body.country ||
    !req.body.postal_code
  ) {
    return res.status(400).json({ error: "Missing required address fields" });
  }
  const location = await stripe.terminal.locations.create({
    display_name: req.body.label,
    address: {
      line1: req.body.line1,
      city: req.body.city,
      state: req.body.state,
      country: req.body.country,
      postal_code: req.body.postal_code,
    },
  });
  res.json(location);
});

app.get("/api/products", async (req, res) => {
  const products = await stripe.products.list({ active: true, limit: 100 });
  const prices = await stripe.prices.list({ active: true, limit: 100 });

  const productMap = products.data.map((product) => {
    const price = prices.data.find(
      (p) => p.product === product.id && p.unit_amount
    );
    return {
      id: product.id,
      name: product.name,
      description: product.description,
      price: price ? price.unit_amount / 100 : 0,
      currency: price ? price.currency : "usd",
      priceId: price?.id || null,
      image:
        product.images && product.images.length > 0 ? product.images[0] : "",
    };
  });
  res.json(productMap);
});

app.post("/api/create-payment-intent", async (req, res) => {
  const { amount, type, metadata } = req.body;
  console.log("req.body", req.body);

  const parsedAmount = Number(amount);
  const amountInCents = Math.round(parsedAmount * 100);

  // Validate the amount
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: "Invalid amount provided." });
  }

  try {
    const intent = await stripe.paymentIntents.create({
      amount: amountInCents, // amount in cents
      currency: "usd",
      capture_method: "manual",
      payment_method_types: ["card_present"],
      metadata: metadata || {},
    });

    res.json({
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret,
    });
  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).json({ error: "Failed to create payment intent." });
  }
});
// Send the PaymentIntent to the reader
app.post("/api/process-payment", async (req, res) => {
  const { readerId, paymentIntentId } = req.body;

  try {
    const reader = await stripe.terminal.readers.processPaymentIntent(
      readerId,
      {
        payment_intent: paymentIntentId,
      }
    );
    res.json(reader);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to process payment" });
  }
});

// Simulate card present on test reader
app.post("/api/simulate-payment", async (req, res) => {
  const { reader_id } = req.body;
  const reader = await stripe.testHelpers.terminal.readers.presentPaymentMethod(
    reader_id,
    {
      card_present: { number: "4242424242424242" },
      type: "card_present",
    }
  );
  res.json(reader);
});

// app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
//     const sig = req.headers["stripe-signature"];
//     let event;

//     try {
//         event = stripe.webhooks.constructEvent(req.body, sig,"");
//     } catch (err) {
//         console.error(`Webhook signature verification failed: ${err.message}`);
//         return res.status(400).send(`Webhook Error: ${err.message}`);
//     }

//     switch (event.type) {
//         case "payment_intent.succeeded":
//             console.log("PaymentIntent was successful!");
//             break;
//         case "payment_intent.payment_failed":
//             console.log("PaymentIntent failed.");
//             break;
//         default:
//             console.warn(`Unhandled event type: ${event.type}`);
//     }

//     res.json({ received: true });
// });

app.get("/api/customers", async (req, res) => {
  const customers = await stripe.customers.list({ limit: 20 });
  res.json(customers.data);
});

// List open invoices
app.get("/api/invoices", async (req, res) => {
  const invoices = await stripe.invoices.list({ limit: 20 });
  res.json(invoices.data);
});

app.post("/api/invoices/:id/pay", async (req, res) => {
  const invoice = await stripe.invoices.retrieve(req.params.id);
  const intent = await stripe.paymentIntents.create({
    amount: invoice.amount_due,
    currency: invoice.currency,
    customer: invoice.customer,
    payment_method_types: ["card_present"],
    capture_method: "manual",
  });
  res.json({ paymentIntentId: intent.id });
});

app.get("/", (req, res) => {
  res.send("Deployed");
});

module.exports = app;
