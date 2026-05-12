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
    "7days": { price: 49, days: 7, name: "7 Days" },
    "monthly": { price: 169, days: 30, name: "1 Month" },
    "3months": { price: 399, days: 90, name: "3 Months" },
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
        const phone = userData.phone || "9999999999";
        const orderId = `SX_${userId.substring(0, 8)}_${Date.now()}`;

        await db.collection("payments").doc(orderId).set({
            userId, plan, amount: planInfo.price, status: "pending",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        const requestBody = {
            zap_key: ZAP_KEY.trim(), order_id: orderId,
            amount: planInfo.price.toString(), customer_mobile: phone,
            remark: `SensiXpert ${planInfo.name} Plan`,
            success_url: REDIRECT_URL, failed_url: REDIRECT_URL,
        };

        const zapupiResponse = await axios.post(ZAPUPI_API_URL, requestBody);
        const paymentData = zapupiResponse.data;
        console.log("ZapUPI response:", JSON.stringify(paymentData));

        if (paymentData && paymentData.payment_url) {
            return res.json({ success: true, paymentUrl: paymentData.payment_url, orderId });
        } else {
            console.error("ZapUPI did not return payment_url:", JSON.stringify(paymentData));
            return res.status(500).json({ error: "Could not create payment", details: paymentData });
        }
    } catch (error) {
        console.error("Create payment error:", error.message);
        if (error.response) {
            console.error("ZapUPI error response:", error.response.status, JSON.stringify(error.response.data));
            return res.status(500).json({ error: "Payment gateway error", status: error.response.status, details: error.response.data });
        }
        return res.status(500).json({ error: error.message });
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

            // ── Referral Commission (30%) ──
            try {
                const userDoc2 = await db.collection("users").doc(userId).get();
                const ud = userDoc2.data();
                const referredBy = ud.referredBy;
                if (referredBy && ud.referralRewardPending) {
                    const commission = Math.round(planInfo.price * 0.30 * 100) / 100;
                    const refDoc = await db.collection("referrals").doc(referredBy).get();
                    if (refDoc.exists) {
                        const referrerUserId = refDoc.data().userId;
                        // Credit wallet
                        const walletRef = db.collection("wallets").doc(referrerUserId);
                        const walletDoc = await walletRef.get();
                        if (walletDoc.exists) {
                            await walletRef.update({
                                balance: admin.firestore.FieldValue.increment(commission),
                                totalEarnings: admin.firestore.FieldValue.increment(commission),
                                updatedAt: admin.firestore.FieldValue.serverTimestamp()
                            });
                        } else {
                            await walletRef.set({ balance: commission, totalEarnings: commission, totalWithdrawn: 0, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                        }
                        // Update referral stats
                        await db.collection("referrals").doc(referredBy).update({
                            successfulReferrals: admin.firestore.FieldValue.increment(1),
                            totalEarnings: admin.firestore.FieldValue.increment(commission)
                        });
                        // Update referral log
                        const logsSnap = await db.collection("referral_logs").where("referredUserId", "==", userId).where("status", "==", "pending").limit(1).get();
                        if (!logsSnap.empty) {
                            await logsSnap.docs[0].ref.update({ status: "completed", plan, amount: planInfo.price, commission, completedAt: admin.firestore.FieldValue.serverTimestamp() });
                        }
                        // Mark reward as done
                        await db.collection("users").doc(userId).update({ referralRewardPending: false });
                        console.log(`🎁 Referral commission ₹${commission} credited to ${referrerUserId}`);
                    }
                }
            } catch (refErr) {
                console.error("Referral commission error (non-fatal):", refErr.message);
            }
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
// POST /send-notification (FCM)
// ═══════════════════════════════════════════════════════════
app.post("/send-notification", async (req, res) => {
    try {
        const { title, message, target, specificUser, link } = req.body;
        if (!title || !message) return res.status(400).json({ error: "title and message are required" });

        // Use Set to prevent duplicate tokens (same device with multiple accounts)
        const tokenSet = new Set();
        if (target === "specific" && specificUser) {
            let userDoc = await db.collection("users").doc(specificUser).get();
            if (!userDoc.exists) {
                const q = await db.collection("users").where("email", "==", specificUser).limit(1).get();
                if (!q.empty) userDoc = q.docs[0];
            }
            if (userDoc && userDoc.exists) {
                const token = userDoc.data().fcmToken;
                if (token) tokenSet.add(token);
            }
        } else {
            const usersSnap = await db.collection("users").get();
            usersSnap.forEach(doc => {
                const data = doc.data();
                const token = data.fcmToken;
                if (!token) return;
                const sub = data.subscription || {};
                const isActive = sub.status === "active" && sub.endDate > Date.now();
                if (target === "subscribers" && isActive) tokenSet.add(token);
                else if (target === "non_subscribers" && !isActive) tokenSet.add(token);
                else if (target === "all") tokenSet.add(token);
            });
        }

        const tokens = [...tokenSet];
        if (tokens.length === 0) return res.json({ success: true, sent: 0, message: "No devices with FCM token found. Users need to open the app first." });

        // Use DATA-ONLY message to prevent Android from auto-showing a duplicate notification.
        // FCMService.onMessageReceived will handle building and displaying the notification.
        const fcmMessage = {
            data: { title, body: message },
            tokens: [],
        };
        if (link) {
            fcmMessage.data.link = link;
        }

        let successCount = 0, failCount = 0;
        for (let i = 0; i < tokens.length; i += 500) {
            const batch = tokens.slice(i, i + 500);
            fcmMessage.tokens = batch;
            const response = await admin.messaging().sendEachForMulticast(fcmMessage);
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
// REFERRAL: Generate Code
// ═══════════════════════════════════════════════════════════
app.post("/generate-referral-code", async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: "userId required" });
        const userDoc = await db.collection("users").doc(userId).get();
        if (!userDoc.exists) return res.status(404).json({ error: "User not found" });
        const userData = userDoc.data();
        if (userData.referralCode) {
            return res.json({ success: true, code: userData.referralCode });
        }
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        let code;
        for (let attempt = 0; attempt < 10; attempt++) {
            code = "SX" + Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
            const existing = await db.collection("referrals").doc(code).get();
            if (!existing.exists) break;
        }
        await db.collection("referrals").doc(code).set({
            code, userId, totalReferrals: 0, successfulReferrals: 0, totalEarnings: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        await db.collection("users").doc(userId).update({ referralCode: code });
        return res.json({ success: true, code });
    } catch (e) {
        console.error("Generate referral code error:", e.message);
        return res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════
// REFERRAL: Get Info
// ═══════════════════════════════════════════════════════════
app.get("/referral-info/:userId", async (req, res) => {
    try {
        const { userId } = req.params;
        const userDoc = await db.collection("users").doc(userId).get();
        if (!userDoc.exists) return res.status(404).json({ error: "User not found" });
        const code = userDoc.data().referralCode || "";
        let stats = { totalReferrals: 0, successfulReferrals: 0, totalEarnings: 0 };
        if (code) {
            const refDoc = await db.collection("referrals").doc(code).get();
            if (refDoc.exists) stats = refDoc.data();
        }
        const walletDoc = await db.collection("wallets").doc(userId).get();
        const wallet = walletDoc.exists ? walletDoc.data() : { balance: 0, totalEarnings: 0, totalWithdrawn: 0 };
        const logsSnap = await db.collection("referral_logs").where("referrerUserId", "==", userId).orderBy("createdAt", "desc").limit(20).get();
        const logs = [];
        logsSnap.forEach(d => logs.push({ id: d.id, ...d.data() }));
        return res.json({ success: true, code, stats, wallet, logs });
    } catch (e) {
        console.error("Referral info error:", e.message);
        return res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════
// REFERRAL: Apply Code
// ═══════════════════════════════════════════════════════════
app.post("/apply-referral", async (req, res) => {
    try {
        const { userId, code } = req.body;
        if (!userId || !code) return res.status(400).json({ error: "userId and code required" });
        const userDoc = await db.collection("users").doc(userId).get();
        if (!userDoc.exists) return res.status(404).json({ error: "User not found" });
        if (userDoc.data().referredBy) return res.status(400).json({ error: "Already used a referral code" });
        const refDoc = await db.collection("referrals").doc(code.toUpperCase()).get();
        if (!refDoc.exists) return res.status(404).json({ error: "Invalid referral code" });
        if (refDoc.data().userId === userId) return res.status(400).json({ error: "Cannot use own code" });
        await db.collection("users").doc(userId).update({ referredBy: code.toUpperCase(), referralRewardPending: true });
        await db.collection("referrals").doc(code.toUpperCase()).update({ totalReferrals: admin.firestore.FieldValue.increment(1) });
        await db.collection("referral_logs").add({
            referrerUserId: refDoc.data().userId, referredUserId: userId, referralCode: code.toUpperCase(),
            status: "pending", plan: null, amount: 0, commission: 0, completedAt: null,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return res.json({ success: true, message: "Referral code applied!" });
    } catch (e) {
        console.error("Apply referral error:", e.message);
        return res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════
// WALLET: Get Info
// ═══════════════════════════════════════════════════════════
app.get("/wallet/:userId", async (req, res) => {
    try {
        const { userId } = req.params;
        const walletDoc = await db.collection("wallets").doc(userId).get();
        const wallet = walletDoc.exists ? walletDoc.data() : { balance: 0, totalEarnings: 0, totalWithdrawn: 0 };
        const wSnap = await db.collection("withdrawals").where("userId", "==", userId).orderBy("requestedAt", "desc").limit(20).get();
        const withdrawals = [];
        wSnap.forEach(d => withdrawals.push({ id: d.id, ...d.data() }));
        return res.json({ success: true, wallet, withdrawals });
    } catch (e) {
        console.error("Wallet error:", e.message);
        return res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════
// WALLET: Request Withdrawal
// ═══════════════════════════════════════════════════════════
app.post("/request-withdrawal", async (req, res) => {
    try {
        const { userId, amount, upiId } = req.body;
        if (!userId || !amount || !upiId) return res.status(400).json({ error: "userId, amount, upiId required" });
        if (amount < 50) return res.status(400).json({ error: "Minimum withdrawal is ₹50" });
        const walletDoc = await db.collection("wallets").doc(userId).get();
        if (!walletDoc.exists) return res.status(400).json({ error: "No wallet found" });
        const wallet = walletDoc.data();
        if (wallet.balance < amount) return res.status(400).json({ error: "Insufficient balance" });
        const pendingSnap = await db.collection("withdrawals").where("userId", "==", userId).where("status", "==", "pending").get();
        if (!pendingSnap.empty) return res.status(400).json({ error: "You already have a pending withdrawal" });
        await db.collection("wallets").doc(userId).update({
            balance: admin.firestore.FieldValue.increment(-amount),
            totalWithdrawn: admin.firestore.FieldValue.increment(amount),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        await db.collection("withdrawals").add({
            userId, amount, upiId, status: "pending", adminNote: "",
            requestedAt: admin.firestore.FieldValue.serverTimestamp(), processedAt: null
        });
        return res.json({ success: true, message: "Withdrawal request submitted" });
    } catch (e) {
        console.error("Withdrawal error:", e.message);
        return res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 SensiXpert Backend running on port ${PORT}`);
});
