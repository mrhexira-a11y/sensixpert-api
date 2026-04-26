const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const axios = require("axios");

// Initialize Firebase Admin with service account
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// ═══════════════════════════════════════════════════════════
// SPACEPAY CONFIGURATION
// ═══════════════════════════════════════════════════════════
const SPACEPAY_PUBLIC_KEY = process.env.SPACEPAY_PUBLIC_KEY || "pk_4o64d8a54cc6d89155a30cd5172a5a707e6bd1f136cf2aab3471aebe6a4ff16";
const SPACEPAY_SECRET_KEY = process.env.SPACEPAY_SECRET_KEY || "4698abdc4c5ce4cc9882781e1c58837e1fa0d8c2597e8b82bf2b6ed2d9e006272";
const SPACEPAY_API_URL = "https://spacepay.in/api/payment/v1/pay";

// This will be your Cloud Run URL after deployment — update if needed
const REDIRECT_URL = process.env.REDIRECT_URL || "https://sensixpert-backend-21963652669.us-central1.run.app/payment-success";

// ═══════════════════════════════════════════════════════════
// PLAN DEFINITIONS
// ═══════════════════════════════════════════════════════════
const PLANS = {
    "7days": { price: 49, days: 7, name: "Basic (7 Days)" },
    "monthly": { price: 169, days: 30, name: "Standard (1 Month)" },
    "3months": { price: 399, days: 90, name: "Premium (3 Months)" },
};

// ═══════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════
app.get("/", (req, res) => {
    res.json({ status: "ok", service: "SensiXpert Backend", timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════
// POST /create-payment
// Called by Android app to initiate a Spacepay payment
// ═══════════════════════════════════════════════════════════
app.post("/create-payment", async (req, res) => {
    try {
        const { userId, plan } = req.body;

        if (!userId || !plan) {
            return res.status(400).json({ error: "userId and plan are required" });
        }

        const planInfo = PLANS[plan];
        if (!planInfo) {
            return res.status(400).json({ error: "Invalid plan" });
        }

        // Get user info from Firestore
        const userDoc = await db.collection("users").doc(userId).get();
        if (!userDoc.exists) {
            return res.status(404).json({ error: "User not found" });
        }
        const userData = userDoc.data();
        const phone = userData.phone || "0000000000";

        // Generate unique order ID
        const orderId = `SX_${userId.substring(0, 8)}_${Date.now()}`;

        // Store pending payment in Firestore for webhook verification
        await db.collection("payments").doc(orderId).set({
            userId: userId,
            plan: plan,
            amount: planInfo.price,
            status: "pending",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Create Spacepay payment
        const spacepayResponse = await axios.post(SPACEPAY_API_URL, {
            public_key: SPACEPAY_PUBLIC_KEY,
            secret_key: SPACEPAY_SECRET_KEY,
            customer_mobile: phone,
            amount: planInfo.price.toString(),
            order_id: orderId,
            redirect_url: REDIRECT_URL,
            note: `SensiXpert ${planInfo.name} Subscription`,
        });

        const paymentData = spacepayResponse.data;

        if (paymentData && paymentData.payment_url) {
            return res.json({
                success: true,
                paymentUrl: paymentData.payment_url,
                orderId: orderId,
            });
        } else {
            console.error("Spacepay response:", paymentData);
            return res.status(500).json({ error: "Could not create payment" });
        }
    } catch (error) {
        console.error("Create payment error:", error.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ═══════════════════════════════════════════════════════════
// POST /webhook
// Called by Spacepay when payment status changes
// This is the ONLY way subscription gets activated
// ═══════════════════════════════════════════════════════════
app.post("/webhook", async (req, res) => {
    try {
        console.log("Webhook received:", JSON.stringify(req.body));

        const { order_id, status, amount, transaction_id } = req.body;

        if (!order_id) {
            return res.status(400).json({ error: "Missing order_id" });
        }

        // Verify payment exists in our records
        const paymentDoc = await db.collection("payments").doc(order_id).get();
        if (!paymentDoc.exists) {
            console.error("Payment not found:", order_id);
            return res.status(404).json({ error: "Payment not found" });
        }

        const paymentData = paymentDoc.data();
        const userId = paymentData.userId;
        const plan = paymentData.plan;
        const expectedAmount = paymentData.amount;

        // Update payment record
        await db.collection("payments").doc(order_id).update({
            status: status,
            transactionId: transaction_id || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Only activate subscription on SUCCESS
        if (status === "success" || status === "SUCCESS") {
            // Verify amount matches
            if (parseInt(amount) !== expectedAmount) {
                console.error(`Amount mismatch: expected ${expectedAmount}, got ${amount}`);
                return res.status(400).json({ error: "Amount mismatch" });
            }

            const planInfo = PLANS[plan];
            if (!planInfo) {
                console.error("Invalid plan in payment:", plan);
                return res.status(400).json({ error: "Invalid plan" });
            }

            const now = Date.now();
            const endDate = now + (planInfo.days * 24 * 60 * 60 * 1000);

            // ✅ Update user's subscription in Firestore
            // This is the ONLY place subscription gets activated
            await db.collection("users").doc(userId).update({
                "subscription.plan": plan,
                "subscription.startDate": now,
                "subscription.endDate": endDate,
                "subscription.status": "active",
            });

            console.log(`✅ Subscription activated for ${userId}: ${plan} until ${new Date(endDate)}`);
        } else {
            console.log(`❌ Payment ${status} for ${order_id}`);
        }

        return res.json({ success: true });
    } catch (error) {
        console.error("Webhook error:", error.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ═══════════════════════════════════════════════════════════
// GET /payment-success
// Redirect URL after Spacepay payment
// ═══════════════════════════════════════════════════════════
app.get("/payment-success", (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Payment Status - SensiXpert</title>
            <style>
                body {
                    background: #080808;
                    color: white;
                    font-family: -apple-system, sans-serif;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    min-height: 100vh;
                    margin: 0;
                    text-align: center;
                }
                .card {
                    background: #1A1A1A;
                    border-radius: 20px;
                    padding: 40px 30px;
                    max-width: 360px;
                    box-shadow: 0 0 40px rgba(255,30,30,0.1);
                }
                .icon { font-size: 60px; margin-bottom: 16px; }
                h2 { color: #00E676; margin-bottom: 8px; }
                p { color: #999; font-size: 14px; margin-bottom: 24px; }
                .btn {
                    background: linear-gradient(to right, #FF1E1E, #D50000);
                    color: white;
                    border: none;
                    padding: 14px 32px;
                    border-radius: 12px;
                    font-size: 16px;
                    font-weight: bold;
                    cursor: pointer;
                    letter-spacing: 1px;
                }
            </style>
        </head>
        <body>
            <div class="card">
                <div class="icon">✅</div>
                <h2>Payment Received!</h2>
                <p>Your subscription will be activated shortly. Go back to SensiXpert app to enjoy premium features.</p>
                <button class="btn" onclick="window.close()">CLOSE</button>
            </div>
        </body>
        </html>
    `);
});

// ═══════════════════════════════════════════════════════════
// GET /check-subscription/:userId
// Optional: manual check endpoint
// ═══════════════════════════════════════════════════════════
app.get("/check-subscription/:userId", async (req, res) => {
    try {
        const { userId } = req.params;
        const userDoc = await db.collection("users").doc(userId).get();

        if (!userDoc.exists) {
            return res.status(404).json({ error: "User not found" });
        }

        const userData = userDoc.data();
        const subscription = userData.subscription || {};

        // Auto-expire check
        if (subscription.status === "active" && subscription.endDate < Date.now()) {
            await db.collection("users").doc(userId).update({
                "subscription.status": "inactive",
            });
            subscription.status = "inactive";
        }

        return res.json({
            isActive: subscription.status === "active" && subscription.endDate > Date.now(),
            subscription: subscription,
        });
    } catch (error) {
        console.error("Check subscription error:", error.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ═══════════════════════════════════════════════════════════
// START SERVER
// Cloud Run provides PORT env variable
// ═══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 SensiXpert Backend running on port ${PORT}`);
});
