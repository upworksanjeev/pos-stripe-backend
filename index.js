const express = require("express");
const cors = require("cors");
const app = express();
const { resolve } = require("path");
require("dotenv").config();
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

app.use(express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/test-deploy", (req, res) => {
  res.send("Deployed");
});

// Create a new connection token (used by frontend Terminal SDK)
app.post("/api/connection-token", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        error: "Stripe is not initialized. Please check your configuration.",
      });
    }
    const token = await stripe.terminal.connectionTokens.create();
    res.json({ secret: token.secret });
  } catch (error) {
    console.error("Error creating connection token:", error);
    res.status(500).json({
      error: "Failed to create connection token",
      details: error.message,
    });
  }
});

// Register a reader to a location
app.post("/api/register-reader", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        error: "Stripe is not initialized. Please check your configuration.",
      });
    }

    if (!req.body.registration_code) {
      return res.status(400).json({ error: "Registration code is required" });
    }

    if (!req.body.location_id) {
      return res.status(400).json({ error: "Location ID is required" });
    }

    const reader = await stripe.terminal.readers.create({
      registration_code: req.body.registration_code,
      location: req.body.location_id,
    });
    res.json(reader);
  } catch (error) {
    console.error("Error registering reader:", error);
    if (error.code === "resource_missing") {
      res.status(404).json({ error: error?.message || "something went wrong" });
    } else if (error.code === "invalid_request_error") {
      res.status(400).json({ error: error?.message || "something went wrong" });
    } else {
      res.status(500).json({
        error: "Failed to register reader",
        details: error.message,
      });
    }
  }
});

// Create a location (one-time use, mainly for setup)
app.post("/api/create-location", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        error: "Stripe is not initialized. Please check your configuration.",
      });
    }

    const { label, line1, city, state, country, postal_code } = req.body;

    if (!label || !line1 || !city || !state || !country || !postal_code) {
      return res.status(400).json({
        error: "Missing required address fields",
        required: ["label", "line1", "city", "state", "country", "postal_code"],
      });
    }

    const location = await stripe.terminal.locations.create({
      display_name: label,
      address: {
        line1: line1,
        city: city,
        state: state,
        country: country,
        postal_code: postal_code,
      },
    });
    res.json(location);
  } catch (error) {
    console.error("Error creating location:", error);
    if (error.code === "invalid_request_error") {
      res.status(400).json({ error: "Invalid address information provided" });
    } else {
      res.status(500).json({
        error: "Failed to create location",
        details: error.message,
      });
    }
  }
});

app.get("/api/products", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        error: "Stripe is not initialized. Please check your configuration.",
      });
    }

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
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).json({
      error: "Failed to fetch products",
      details: error.message,
    });
  }
});

// Create a PaymentIntent (used by product, custom, or invoice payment)
app.post("/api/create-payment-intent", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        error: "Stripe is not initialized. Please check your configuration.",
      });
    }

    const { amount, type, metadata } = req.body;

    const { name, email } = metadata;

    if (!name || !email) {
      return res
        .status(400)
        .json({ error: "Customer email and name is required" });
    }

    if (!amount || amount <= 0) {
      return res
        .status(400)
        .json({ error: "Valid amount is required (must be greater than 0)" });
    }

    const customer = await stripe.customers.create({
      email: email,
      name: name,
    });

    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency: "usd",
      payment_method_types: ["card_present"],
      metadata: { ...metadata, name: email } || {},
      receipt_email: email,
      customer: customer?.id,
      shipping: {
        name: name,
        address: {
          line1: "",
          city: "",
          state: "",
          postal_code: "",
          country: "",
        },
      },
    });

    res.json({
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret,
    });
  } catch (error) {
    console.error("Error creating payment intent:", error);
    if (error.code === "parameter_invalid_integer") {
      res.status(400).json({ error: "Invalid amount provided" });
    } else {
      res.status(500).json({
        error: "Failed to create payment intent",
        details: error.message,
      });
    }
  }
});

// Send the PaymentIntent to the reader
app.post("/api/process-payment", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        error: "Stripe is not initialized. Please check your configuration.",
      });
    }

    const { readerId, paymentIntentId } = req.body;

    if (!readerId) {
      return res.status(400).json({
        error: "Reader is required please ensure reader is connected",
      });
    }

    if (!paymentIntentId) {
      return res.status(400).json({ error: "Payment Intent ID is required" });
    }

    const reader = await stripe.terminal.readers.processPaymentIntent(
      readerId,
      {
        payment_intent: paymentIntentId,
        // process_config: {
        //   enable_customer_cancellation: true,
        // },
      }
    );
    res.json(reader);
  } catch (error) {
    console.error("Error processing payment:", error);
    if (error.code === "resource_missing") {
      res.status(404).json({ error: "Reader or payment intent not found" });
    } else if (error.code === "terminal_reader_timeout") {
      res.status(409).json({
        error: "Reader connection timeout please check the reader connection",
      });
    } else if (error.code === "terminal_reader_busy") {
      res
        .status(409)
        .json({ error: "Reader is currently busy with another operation" });
    } else if (error.code === "terminal_reader_offline") {
      res
        .status(503)
        .json({ error: "Reader is offline. Please check the connection." });
    } else {
      res.status(500).json({
        error: "Failed to process payment",
        details: error.message,
      });
    }
  }
});

// Simulate card present on test reader
app.post("/api/simulate-payment", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        error: "Stripe is not initialized. Please check your configuration.",
      });
    }

    const { reader_id } = req.body;

    if (!reader_id) {
      return res.status(400).json({ error: "Reader ID is required" });
    }

    const reader =
      await stripe.testHelpers.terminal.readers.presentPaymentMethod(
        reader_id,
        {
          card_present: { number: "4242424242424242" },
          type: "card_present",
        }
      );
    res.json(reader);
  } catch (error) {
    console.error("Error simulating payment:", error);
    if (error.code === "resource_missing") {
      res.status(404).json({ error: "Reader not found" });
    } else {
      res.status(500).json({
        error: "Failed to simulate payment",
        details: error.message,
      });
    }
  }
});

app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      if (!process.env.STRIPE_WEBHOOK_SECRET) {
        console.error("STRIPE_WEBHOOK_SECRET is not set");
        return res.status(500).json({ error: "Webhook secret not configured" });
      }

      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error(`Webhook signature verification failed: ${err.message}`);
      return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    try {
      switch (event.type) {
        case "payment_intent.succeeded":
          console.log("PaymentIntent was successful!");
          break;
        case "payment_intent.payment_failed":
          console.log("PaymentIntent failed.");
          break;
        default:
          console.warn(`Unhandled event type: ${event.type}`);
      }

      res.json({ received: true });
    } catch (error) {
      console.error("Error processing webhook:", error);
      res.status(500).json({ error: "Failed to process webhook" });
    }
  }
);

app.get("/api/customers", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        error: "Stripe is not initialized. Please check your configuration.",
      });
    }

    const customers = await stripe.customers.list({ limit: 20 });
    res.json(customers.data);
  } catch (error) {
    console.error("Error fetching customers:", error);
    res.status(500).json({
      error: "Failed to fetch customers",
      details: error.message,
    });
  }
});

// List open invoices
app.get("/api/invoices", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        error: "Stripe is not initialized. Please check your configuration.",
      });
    }

    const invoices = await stripe.invoices.list({ limit: 40 });
    const sortedInvoices = invoices.data.sort((a, b) => {
      const statusOrder = { open: 0, draft: 1, uncollectible: 2, paid: 3, void: 4 };
      return (statusOrder[b.status] || 99) - (statusOrder[a.status] || 99);
    });
    res.json(sortedInvoices);
  } catch (error) {
    console.error("Error fetching invoices:", error);
    res.status(500).json({
      error: "Failed to fetch invoices",
      details: error.message,
    });
  }
});

app.post("/api/invoices/:id/pay", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        error: "Stripe is not initialized. Please check your configuration.",
      });
    }

    const invoiceId = req.params.id;

    if (!invoiceId) {
      return res.status(400).json({ error: "Invoice ID is required" });
    }

    const invoice = await stripe.invoices.retrieve(invoiceId);

    if (!invoice) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    const intent = await stripe.paymentIntents.create({
      amount: invoice.amount_due,
      currency: invoice.currency,
      customer: invoice.customer,
      payment_method_types: ["card_present"],
    });

    await stripe.invoices.attachPayment(invoiceId, {
      payment_intent: intent.id,
      expand: ["payments"],
    });
    res.json({ paymentIntentId: intent.id });
  } catch (error) {
    console.error("Error processing invoice payment:", error);
    if (error.code === "resource_missing") {
      res.status(404).json({ error: "Invoice not found" });
    } else if (error.code === "invalid_request_error") {
      res
        .status(400)
        .json({ error: "Invalid invoice or customer information" });
    } else {
      res.status(500).json({
        error: "Failed to process invoice payment",
        details: error.message,
      });
    }
  }
});

app.post("/api/cancel-payment-intent", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        error: "Stripe is not initialized. Please check your configuration.",
      });
    }

    const { paymentIntentId, readerId } = req.body;

    if (!paymentIntentId || !readerId) {
      return res
        .status(400)
        .json({ error: "Both paymentIntentId and readerId are required" });
    }

    // Step 1: Get the current status
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (intent.status === "succeeded") {
      return res.status(409).json({
        error: "Payment already succeeded and cannot be canceled",
        status: "succeeded",
        paymentIntent: intent,
      });
    }else if(
      intent.status === "cancelled"
    ){
      return res.status(200).json({
        error: "Payment already cancelled",
        status: "succeeded",
        paymentIntent: intent,
      });
    }

    // Step 2: Cancel reader action if it's in progress
    const reader = await stripe.terminal.readers.cancelAction(readerId);


    // Step 3: Cancel the PaymentIntent
    const cancelledIntent = await stripe.paymentIntents.cancel(paymentIntentId);
    

    res.json({
      message: "Payment canceled successfully",
      reader,
      cancelledIntent,
    });
  } catch (error) {
    console.error("Error in cancel-payment-intent:", error);
    res.status(500).json({ error: error.message });
  }
});

// Global error handler for unhandled errors
app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({
    error: "Internal server error",
    details:
      process.env.NODE_ENV === "development"
        ? error.message
        : "Something went wrong",
  });
});
app.get("/api/payment-intent-status", async (req, res) => {
  try {
    const { id } = req.query;
    const intent = await stripe.paymentIntents.retrieve(id);
    res.json({ status: intent.status });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch payment intent status" });
  }
});
// 404 handler for undefined routes
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Start server
app.listen(4242, () => console.log("Server running on http://localhost:4242"));
