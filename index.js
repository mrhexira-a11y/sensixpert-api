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
// ZAPUPI CONFIGURATION
// ═══════════════════════════════════════════════════════════
const ZAP_KEY = process.env.ZAP_KEY || "zapf04a091271fe611b36cd63bdc918bd2d";
const ZAPUPI_API_URL = "https://pay.zapupi.com/api/create-order";
const ZAPUPI_STATUS_URL = "https://pay.zapupi.com/api/order-status";

const REDIRECT_URL = process.env.REDIRECT_URL || "https://sensixpert-backend.onrender.com/payment-success";

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
    res.json({ status: "ok", service: "SensiXpert Backend", gateway: "ZapUPI", timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════
// POST /create-payment
// ═══════════════════════════════════════════════════════════
app.post("/create-payment", async (req, res) => {
    try {
        const { userId, plan } = req.body;
        if (!userId || !plan) return res.status(400).json({ error: "userId and plan are required" });

        const planInfo = PLANS[plan];
        if (!planInfo) return res.status(400).json({ error: "Invalid plan" });

        const userDoc = await db.collection("users").doc(userId).get();
        if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

        const userData = userDoc.data();
        const phone = userData.phone || "0000000000";
        const orderId = `SX_${userId.substring(0, 8)}_${Date.now()}`;

        await db.collection("payments").doc(orderId).set({
            userId, plan, amount: planInfo.price, status: "pending",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        const requestBody = {
            zap_key: ZAP_KEY.trim(), order_id: orderId,
            amount: planInfo.price.toString(), customer_mobile: phone,
            remark: `SensiXpert ${planInfo.name} Subscription`,
            success_url: REDIRECT_URL, failed_url: REDIRECT_URL,
        };

        const zapupiResponse = await axios.post(ZAPUPI_API_URL, requestBody);
        const paymentData = zapupiResponse.data;

        if (paymentData && paymentData.payment_url) {
            return res.json({ success: true, paymentUrl: paymentData.payment_url, orderId });
        } else {
            return res.status(500).json({ error: "Could not create payment" });
        }
    } catch (error) {
        console.error("Create payment error:", error.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ═══════════════════════════════════════════════════════════
// POST /webhook
// ═══════════════════════════════════════════════════════════
app.post("/webhook", async (req, res) => {
    try {
        console.log("Webhook received:", JSON.stringify(req.body));
        const { order_id, status, amount, txn_id, utr, pay_amount } = req.body;
        if (!order_id) return res.status(400).json({ error: "Missing order_id" });

        const paymentDoc = await db.collection("payments").doc(order_id).get();
        if (!paymentDoc.exists) return res.status(404).json({ error: "Payment not found" });

        const paymentData = paymentDoc.data();
        const userId = paymentData.userId;
        const plan = paymentData.plan;
        const expectedAmount = paymentData.amount;

        await db.collection("payments").doc(order_id).update({
            status, transactionId: txn_id || null, utr: utr || null,
            payAmount: pay_amount || null, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        if (status === "Success" || status === "success" || status === "SUCCESS") {
            if (parseInt(amount) !== expectedAmount) return res.status(400).json({ error: "Amount mismatch" });
            const planInfo = PLANS[plan];
            if (!planInfo) return res.status(400).json({ error: "Invalid plan" });

            const now = Date.now();
            const endDate = now + (planInfo.days * 24 * 60 * 60 * 1000);
            await db.collection("users").doc(userId).update({
                "subscription.plan": plan, "subscription.startDate": now,
                "subscription.endDate": endDate, "subscription.status": "active",
            });
            console.log(`✅ Subscription activated for ${userId}: ${plan}`);
        }
        return res.json({ success: true });
    } catch (error) {
        console.error("Webhook error:", error.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ═══════════════════════════════════════════════════════════
// GET /payment-success
// ═══════════════════════════════════════════════════════════
app.get("/payment-success", (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Payment Status</title><style>body{background:#080808;color:white;font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;text-align:center}.card{background:#1A1A1A;border-radius:20px;padding:40px 30px;max-width:360px;box-shadow:0 0 40px rgba(255,30,30,0.1)}.icon{font-size:60px;margin-bottom:16px}h2{color:#00E676;margin-bottom:8px}p{color:#999;font-size:14px;margin-bottom:24px}.btn{background:linear-gradient(to right,#FF1E1E,#D50000);color:white;border:none;padding:14px 32px;border-radius:12px;font-size:16px;font-weight:bold;cursor:pointer}</style></head><body><div class="card"><div class="icon">✅</div><h2>Payment Received!</h2><p>Your subscription will be activated shortly. Go back to SensiXpert app.</p><button class="btn" onclick="window.close()">CLOSE</button></div></body></html>`);
});

// ═══════════════════════════════════════════════════════════
// POST /check-order-status
// ═══════════════════════════════════════════════════════════
app.post("/check-order-status", async (req, res) => {
    try {
        const { orderId } = req.body;
        if (!orderId) return res.status(400).json({ error: "orderId is required" });
        const statusResponse = await axios.post(ZAPUPI_STATUS_URL, { zap_key: ZAP_KEY.trim(), order_id: orderId });
        return res.json(statusResponse.data);
    } catch (error) {
        console.error("Check order status error:", error.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ═══════════════════════════════════════════════════════════
// GET /check-subscription/:userId
// ═══════════════════════════════════════════════════════════
app.get("/check-subscription/:userId", async (req, res) => {
    try {
        const { userId } = req.params;
        const userDoc = await db.collection("users").doc(userId).get();
        if (!userDoc.exists) return res.status(404).json({ error: "User not found" });
        const userData = userDoc.data();
        const subscription = userData.subscription || {};
        if (subscription.status === "active" && subscription.endDate < Date.now()) {
            await db.collection("users").doc(userId).update({ "subscription.status": "inactive" });
            subscription.status = "inactive";
        }
        return res.json({ isActive: subscription.status === "active" && subscription.endDate > Date.now(), subscription });
    } catch (error) {
        return res.status(500).json({ error: "Internal server error" });
    }
});

// ═══════════════════════════════════════════════════════════
// POST /send-notification (FCM - original)
// ═══════════════════════════════════════════════════════════
app.post("/send-notification", async (req, res) => {
    try {
        const { title, message, target, specificUser } = req.body;
        if (!title || !message) return res.status(400).json({ error: "title and message are required" });

        let tokens = [];
        if (target === "specific" && specificUser) {
            let userDoc = await db.collection("users").doc(specificUser).get();
            if (!userDoc.exists) {
                const q = await db.collection("users").where("email", "==", specificUser).limit(1).get();
                if (!q.empty) userDoc = q.docs[0];
            }
            if (userDoc && userDoc.exists) {
                const token = userDoc.data().fcmToken;
                if (token) tokens.push(token);
            }
        } else {
            const usersSnap = await db.collection("users").get();
            usersSnap.forEach(doc => {
                const data = doc.data();
                const token = data.fcmToken;
                if (!token) return;
                const sub = data.subscription || {};
                const isActive = sub.status === "active" && sub.endDate > Date.now();
                if (target === "subscribers" && isActive) tokens.push(token);
                else if (target === "non_subscribers" && !isActive) tokens.push(token);
                else if (target === "all") tokens.push(token);
            });
        }

        if (tokens.length === 0) return res.json({ success: true, sent: 0, message: "No devices found" });

        let successCount = 0, failCount = 0;
        for (let i = 0; i < tokens.length; i += 500) {
            const batch = tokens.slice(i, i + 500);
            const response = await admin.messaging().sendEachForMulticast({
                notification: { title, body: message },
                tokens: batch,
            });
            successCount += response.successCount;
            failCount += response.failureCount;
        }
        return res.json({ success: true, sent: successCount, failed: failCount, total: tokens.length });
    } catch (error) {
        console.error("Send notification error:", error.message);
        return res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 SensiXpert Backend running on port ${PORT}`);
});
