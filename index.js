const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');
const path = require('path');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');

// --- FIREBASE IMPORTS AND SETUP ---
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, addDoc, query, where, getDocs, updateDoc, doc } = require('firebase/firestore');

// Load environment variables from .env file
dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- FIREBASE/FIRESTORE INITIALIZATION ---
let db;
let dbReady = false;
let userId = 'default-admin'; // Fallback

try {
    const firebaseConfig = JSON.parse(typeof __firebase_config !== 'undefined' ? __firebase_config : '{}');
    const appInstance = initializeApp(firebaseConfig);
    db = getFirestore(appInstance);
    
    dbReady = true;
    console.log("Firestore initialized successfully. Using public collections.");
} catch (error) {
    console.error("FIREBASE ERROR: Failed to initialize Firestore. Data will not be saved.", error);
}

// Define collection paths (MUST use the /artifacts/{appId}/public/data/ path structure)
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const transactionsCollection = `artifacts/${appId}/public/data/transactions`;
const ticketsCollection = `artifacts/${appId}/public/data/tickets`;

// Ticket configuration (Unchanged)
const ticketConfig = {
    Regular: { price: 1000, people: 1 },
    Children: { price: 300, people: 1 },
    VIP: { price: 2000, people: 1 },
    VVIP: { price: 3000, people: 1 },
    Executive: { price: 5000, people: 1 },
    Family4: { price: 20000, people: 4 },
    Family6: { price: 25000, people: 6 },
    Corp6: { price: 50000, people: 6 },
    Corp8: { price: 60000, people: 8 },
    Corp12: { price: 100000, people: 12 },
};

// Email transporter (Unchanged)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});


// --- FIRESTORE HELPER FUNCTIONS ---

async function saveTransaction(data) {
    if (!dbReady) return console.error("DB not ready.");
    try {
        const docRef = await addDoc(collection(db, transactionsCollection), data);
        return docRef.id;
    } catch (e) {
        console.error("Error saving transaction:", e);
    }
}

async function saveTicket(data) {
    if (!dbReady) return console.error("DB not ready.");
    try {
        await addDoc(collection(db, ticketsCollection), data);
    } catch (e) {
        console.error("Error saving ticket:", e);
    }
}

async function getTicketsByReceipt(mpesaReceipt) {
    if (!dbReady) return [];
    try {
        const q = query(collection(db, ticketsCollection), where("mpesaReceipt", "==", mpesaReceipt));
        const snapshot = await getDocs(q);
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (e) {
        console.error("Error fetching tickets:", e);
        return [];
    }
}

async function updateTicketUsage(ticketDocId) {
    if (!dbReady) return false;
    try {
        const ticketRef = doc(db, ticketsCollection, ticketDocId);
        await updateDoc(ticketRef, { used: true });
        return true;
    } catch (e) {
        console.error("Error updating ticket usage:", e);
        return false;
    }
}

// Get token middleware (FIXED: Synchronized MPESA_SECRET_KEY to MPESA_CONSUMER_SECRET)
async function getToken(req, res, next) {
    // Check environment variables first
    if (!process.env.MPESA_CONSUMER_KEY || !process.env.MPESA_CONSUMER_SECRET || !process.env.MPESA_API_BASE_URL) {
        console.error("M-PESA CREDENTIAL ERROR: Missing one or more required environment variables (KEY, SECRET, BASE_URL).");
        return res.status(500).json({ error: 'M-Pesa credentials not configured on server.' });
    }
    
    // Use the correctly named CONSUMER_SECRET
    const { MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_API_BASE_URL } = process.env;
    const OAUTH_URL = `${MPESA_API_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`;
    // Base64 encode the Key:Secret string
    const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
    
    try {
        const { data } = await axios.get(OAUTH_URL, {
            headers: { Authorization: `Basic ${auth}` },
        });
        req.token = data.access_token;
        next();
    } catch (error) {
        console.error("Token failure:", error.message);
        // This is where the original error occurs. The fix above addresses the cause.
        res.status(500).json({ error: 'Failed to get M-Pesa token' });
    }
}

// Serve frontend (Updated to target 'event-concert-1.html' in the 'frontend' folder)
app.use(express.static(path.join(__dirname, 'frontend')));
app.get('/', (req, res) => {
    // Serve your specific ticket page at the root
    res.sendFile(path.join(__dirname, 'frontend', 'event-concert-1.html'));
});

// Initiate payment (M-Pesa STK Push)
app.post('/api/stkpush', getToken, async (req, res) => {
    const { phone, ticketType, quantity = 1, accountReference = 'DefaultRef', email } = req.body;
    
    if (!ticketConfig[ticketType]) return res.status(400).send('Invalid ticket type');
    if (!email) return res.status(400).send('Email required');

    const config = ticketConfig[ticketType];
    const amount = config.price * (config.people === 1 ? quantity : 1);
    
    // FIXED: Synchronized MPESA_PAYBILL to MPESA_SHORTCODE
    const { MPESA_SHORTCODE, MPESA_PASSKEY, MPESA_API_BASE_URL, MPESA_CALLBACK_URL } = process.env;
    
    if (!MPESA_SHORTCODE || !MPESA_PASSKEY || !MPESA_CALLBACK_URL) {
        console.error("M-PESA STK ERROR: Missing SHORTCODE, PASSKEY, or CALLBACK_URL in environment variables.");
        return res.status(500).json({ error: 'M-Pesa STK configuration incomplete.' });
    }

    const STK_PUSH_URL = `${MPESA_API_BASE_URL}/mpesa/stkpush/v1/processrequest`;

    const timestamp = new Date().toISOString().replace(/[-T:\.Z]/g, '').slice(0, 14);
    // Use SHORTCODE instead of the old PAYBILL variable name
    const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');

    const payload = {
        BusinessShortCode: MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: phone,
        PartyB: MPESA_SHORTCODE,
        PhoneNumber: phone,
        // Pass essential data back in the callback URL query
        CallBackURL: `${MPESA_CALLBACK_URL}?type=${ticketType}&qty=${quantity}&ref=${encodeURIComponent(accountReference)}&email=${encodeURIComponent(email)}`,
        AccountReference: accountReference,
        TransactionDesc: `Payment for ${ticketType} tickets`,
    };

    try {
        await axios.post(STK_PUSH_URL, payload, {
            headers: { Authorization: `Bearer ${req.token}` },
        });
        res.send('Payment request sent to your phone. Check your M-Pesa prompt.');
    } catch (error) {
        console.error("STK Push Failure:", error.message);
        res.status(500).json({ error: 'Failed to initiate payment. Check M-Pesa API logs.' });
    }
});

// Callback from Safaricom (Stores transaction and generates tickets in Firestore)
app.post('/api/callback', async (req, res) => {
    const callback = req.body.Body?.stkCallback;
    if (!callback) return res.status(400).json({ error: 'Invalid callback body' });

    // Acknowledge receipt to M-Pesa immediately
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

    const transaction = {
        merchantRequestID: callback.MerchantRequestID,
        checkoutRequestID: callback.CheckoutRequestID,
        resultCode: callback.ResultCode,
        resultDesc: callback.ResultDesc,
        ticketType: req.query.type || '',
        quantity: parseInt(req.query.qty) || 1,
        accountReference: req.query.ref || '',
        email: req.query.email || '',
        timestamp: new Date().toISOString(),
    };

    if (callback.ResultCode === 0) {
        const metadata = callback.CallbackMetadata.Item;
        const details = metadata.reduce((acc, item) => { acc[item.Name] = item.Value; return acc; }, {});
        
        // Add transaction details
        transaction.amount = details.Amount;
        transaction.mpesaReceipt = details.MpesaReceiptNumber;
        transaction.phone = details.PhoneNumber;
        transaction.transactionDate = details.TransactionDate;

        // 1. Save Transaction to Firestore
        const transactionId = await saveTransaction(transaction);
        
        // 2. Generate and Save Tickets
        const config = ticketConfig[transaction.ticketType];
        const numTickets = config ? config.people * (config.people === 1 ? transaction.quantity : 1) : 1;
        
        const generatedCodes = [];
        for (let i = 0; i < numTickets; i++) {
            const ticketCode = 'TKT-' + Math.random().toString(36).substring(2, 10).toUpperCase();
            
            // Generate QR Code (Base64 string for display/email)
            const qrBase64 = await QRCode.toDataURL(ticketCode); 

            await saveTicket({
                transactionId, // Link to the main transaction
                phone: transaction.phone,
                email: transaction.email,
                accountReference: transaction.accountReference,
                ticketCode,
                qrBase64,
                mpesaReceipt: transaction.mpesaReceipt,
                type: transaction.ticketType,
                used: false,
                timestamp: transaction.timestamp,
            });

            generatedCodes.push(ticketCode);
        }

        console.log(`[SUCCESS] Receipt: ${transaction.mpesaReceipt}. Tickets generated: ${generatedCodes.length}.`);
    } else {
        console.log(`[FAILED] M-Pesa Payment failed: ${transaction.resultDesc}`);
    }
});

// --- ADMIN DASHBOARD AND TICKET MANAGEMENT ROUTES ---

// Serve the Wepesi Dashboard HTML file
app.get('/wepesi', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend', 'wepesi.html'));
});


// Admin: Send Email Route (Called from the /wepesi dashboard)
app.post('/api/send-email', async (req, res) => {
    const { mpesaReceipt } = req.body;
    
    // In a real app, you would fetch transaction details here too.
    const userTickets = await getTicketsByReceipt(mpesaReceipt);
    
    if (!userTickets.length) return res.status(400).send('No tickets found for this receipt.');

    const transaction = { email: userTickets[0].email, mpesaReceipt }; // Mock transaction data for email recipient
    
    let emailHtml = '<h2>Your Concert Tickets</h2><p>Thank you for your purchase! Here are your QR codes and verification codes:</p><ul>';
    userTickets.forEach(t => {
        emailHtml += `<li>Code: ${t.ticketCode} (${t.type})<br><img src="${t.qrBase64}" alt="QR for ${t.ticketCode}" width="200"></li>`;
    });
    emailHtml += `</ul><p>Receipt: ${mpesaReceipt}.</p>`;

    try {
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: transaction.email,
            subject: 'Your Concert Tickets and QR Codes',
            html: emailHtml,
        });
        res.send(`Email sent successfully to ${transaction.email}.`);
    } catch (error) {
        console.error(`Email send failed for ${transaction.email}:`, error);
        res.status(500).send('Failed to send email. Check Nodemailer configuration and logs.');
    }
});

// Admin: Fetch all transactions and tickets for dashboard
app.get('/api/admin/transactions', async (req, res) => {
    if (!dbReady) return res.status(500).json([]);
    
    try {
        // 1. Fetch all transactions
        const transQuery = query(collection(db, transactionsCollection));
        const transSnapshot = await getDocs(transQuery);
        const transactions = transSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // 2. Fetch all tickets
        const ticketQuery = query(collection(db, ticketsCollection));
        const ticketSnapshot = await getDocs(ticketQuery);
        const tickets = ticketSnapshot.docs.map(doc => doc.data());

        // 3. Combine data for the dashboard
        const dashboardData = transactions.map(trans => {
            const linkedTickets = tickets.filter(t => t.mpesaReceipt === trans.mpesaReceipt)
                .map(t => ({ code: t.ticketCode, used: t.used, type: t.type }));
            
            return {
                ...trans,
                linkedTickets,
                ticketCount: linkedTickets.length,
            };
        });

        res.json(dashboardData);
    } catch (e) {
        console.error("Error fetching admin data:", e);
        res.status(500).json({ error: "Failed to fetch dashboard data." });
    }
});


// Admin: Verify Ticket at Gate
app.post('/api/verify-ticket', async (req, res) => {
    const { ticketCode } = req.body;
    
    if (!dbReady) return res.status(500).send('Database connection error.');

    try {
        const q = query(collection(db, ticketsCollection), where("ticketCode", "==", ticketCode));
        const snapshot = await getDocs(q);

        if (snapshot.empty) return res.send('Invalid ticket code.');

        const ticketDoc = snapshot.docs[0];
        const ticketData = ticketDoc.data();
        
        if (ticketData.used) return res.send('Ticket already used.');

        // Mark as used
        await updateTicketUsage(ticketDoc.id);
        
        res.send(`Ticket ${ticketCode} verified and marked used. Welcome!`);
    } catch (e) {
        console.error("Ticket verification error:", e);
        res.status(500).send('Verification failed due to server error.');
    }
});


// Start the server
app.listen(process.env.PORT || 3000, () => 
    console.log(`Server running on port ${process.env.PORT || 3000}`)
);
