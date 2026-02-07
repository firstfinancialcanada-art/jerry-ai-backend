// indexnew-master-02-06.js
// Jerry AI Backend - Database Edition (cleaned & deployment ready)

const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// ===== DATABASE CONNECTION =====

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false,
});

pool
  .connect()
  .then(() => console.log('✅ Database connected'))
  .catch((err) => console.error('❌ Database connection error:', err.message));

// ===== EMAIL SETUP =====

const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

async function sendEmailNotification(subject, htmlContent) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    console.log('⚠️ Email not configured, skipping email send');
    return false;
  }

  try {
    const info = await emailTransporter.sendMail({
      from: `"Jerry AI - First Financial" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_TO || 'firstfinancialcanada@gmail.com',
      subject,
      html: htmlContent,
    });
    console.log('📧 Email sent:', info.messageId);
    return true;
  } catch (error) {
    console.error('❌ Email error:', error.message);
    return false;
  }
}

// ===== TWILIO SETUP =====

const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
const twilioFromNumber = process.env.TWILIO_PHONE_NUMBER;

let twilioClient = null;
if (twilioAccountSid && twilioAuthToken) {
  twilioClient = twilio(twilioAccountSid, twilioAuthToken);
} else {
  console.warn('⚠️ Twilio not fully configured. SMS send will be skipped.');
}

// ===== HELPERS =====

function formatPhone(phone) {
  if (!phone) return '';
  const cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    return '+1 (' + cleaned.slice(1, 4) + ') ' + cleaned.slice(4, 7) + '-' + cleaned.slice(7);
  }
  if (cleaned.length === 10) {
    return '+1 (' + cleaned.slice(0, 3) + ') ' + cleaned.slice(3, 6) + '-' + cleaned.slice(6);
  }
  return phone;
}

// ===== DATABASE HELPER FUNCTIONS =====

async function getOrCreateCustomer(phone) {
  const existing = await pool.query(
    'SELECT * FROM customers WHERE phone = $1',
    [phone]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const inserted = await pool.query(
    'INSERT INTO customers (phone) VALUES ($1) RETURNING *',
    [phone]
  );
  console.log('📝 New customer created:', phone);
  return inserted.rows[0];
}

async function getOrCreateConversation(phone) {
  const existing = await pool.query(
    "SELECT * FROM conversations WHERE customer_phone = $1 AND status = 'active' ORDER BY started_at DESC LIMIT 1",
    [phone]
  );

  if (existing.rows.length > 0) {
    const conv = existing.rows[0];
    await pool.query(
      'UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [conv.id]
    );
    console.log('💬 Continuing conversation:', phone);
    return conv;
  }

  const inserted = await pool.query(
    'INSERT INTO conversations (customer_phone, status, stage) VALUES ($1, $2, $3) RETURNING *',
    [phone, 'active', 'greeting']
  );
  console.log('💬 New conversation started:', phone);
  return inserted.rows[0];
}

async function updateConversation(conversationId, updates) {
  const fields = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = $${idx}`);
    values.push(value);
    idx += 1;
  }

  if (!fields.length) return;

  values.push(conversationId);

  await pool.query(
    `UPDATE conversations SET ${fields.join(
      ', '
    )}, updated_at = CURRENT_TIMESTAMP WHERE id = $${idx}`,
    values
  );
}

async function touchConversation(conversationId) {
  await pool.query(
    'UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
    [conversationId]
  );
}

async function hasActiveConversation(phone) {
  const result = await pool.query(
    "SELECT id FROM conversations WHERE customer_phone = $1 AND status = 'active' LIMIT 1",
    [phone]
  );
  return result.rows.length > 0;
}

async function deleteConversationByPhone(phone) {
  // Deletes latest conversation for a phone plus related rows
  const convRes = await pool.query(
    'SELECT id FROM conversations WHERE customer_phone = $1 ORDER BY started_at DESC LIMIT 1',
    [phone]
  );

  if (convRes.rows.length === 0) {
    return false;
  }

  const conversationId = convRes.rows[0].id;

  await pool.query('DELETE FROM messages WHERE conversation_id = $1', [
    conversationId,
  ]);
  await pool.query('DELETE FROM appointments WHERE customer_phone = $1', [
    phone,
  ]);
  await pool.query('DELETE FROM callbacks WHERE customer_phone = $1', [phone]);
  await pool.query('DELETE FROM conversations WHERE id = $1', [conversationId]);

  console.log('🗑️ Conversation deleted (with appointments & callbacks):', phone);
  return true;
}

async function saveMessage(conversationId, phone, role, content) {
  await pool.query(
    'INSERT INTO messages (conversation_id, customer_phone, role, content) VALUES ($1, $2, $3, $4)',
    [conversationId, phone, role, content]
  );
}

async function saveAppointment(data) {
  await pool.query(
    'INSERT INTO appointments (customer_phone, customer_name, vehicle_type, budget, budget_amount, datetime) VALUES ($1, $2, $3, $4, $5, $6)',
    [
      data.phone,
      data.name,
      data.vehicleType,
      data.budget,
      data.budgetAmount,
      data.datetime,
    ]
  );
  console.log('🚗 Appointment saved:', data.name || data.phone);
}

async function saveCallback(data) {
  await pool.query(
    'INSERT INTO callbacks (customer_phone, customer_name, vehicle_type, budget, budget_amount, datetime) VALUES ($1, $2, $3, $4, $5, $6)',
    [
      data.phone,
      data.name,
      data.vehicleType,
      data.budget,
      data.budgetAmount,
      data.datetime,
    ]
  );
  console.log('📞 Callback saved:', data.name || data.phone);
}

async function logAnalytics(eventType, phone, data) {
  try {
    await pool.query(
      'INSERT INTO analytics (event_type, customer_phone, data) VALUES ($1, $2, $3)',
      [eventType, phone, JSON.stringify(data || {})]
    );
  } catch (err) {
    console.error('⚠️ Analytics log error:', err.message);
  }
}

// ===== JERRY AI LOGIC =====

function extractBudget(message) {
  const digits = message.replace(/[^\d]/g, '');
  if (!digits) return null;
  const num = parseInt(digits, 10);
  if (!Number.isFinite(num)) return null;
  return num;
}

function extractNameFromMessage(message) {
  const lower = message.toLowerCase();
  let name = null;

  if (lower.includes('my name is')) {
    name = message.split(/my name is/i)[1]?.trim();
  } else if (lower.includes("i'm ") || lower.includes('im ')) {
    name = message.split(/i[' ]?m/i)[1]?.trim();
  } else if (lower.includes('i am ')) {
    name = message.split(/i am/i)[1]?.trim();
  }

  if (!name) return null;
  name = name.replace(/[^a-zA-Z\s]/g, '').trim();
  if (!name) return null;
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

function normalizeVagueDatetime(message) {
  const lower = message.toLowerCase().trim();
  let finalDateTime = message;

  if (lower.includes('today')) {
    if (lower.includes('morning')) finalDateTime = 'Today morning';
    else if (lower.includes('afternoon')) finalDateTime = 'Today afternoon';
    else if (lower.includes('evening') || lower.includes('tonight'))
      finalDateTime = 'Today evening';
    else finalDateTime = 'Today afternoon';
  } else if (lower.includes('tomorrow')) {
    if (lower.includes('morning')) finalDateTime = 'Tomorrow morning';
    else if (lower.includes('afternoon')) finalDateTime = 'Tomorrow afternoon';
    else if (lower.includes('evening') || lower.includes('tonight'))
      finalDateTime = 'Tomorrow evening';
    else finalDateTime = 'Tomorrow afternoon';
  } else if (lower.includes('this weekend') || lower.includes('weekend')) {
    finalDateTime = 'This weekend';
  } else if (lower.includes('next week')) {
    finalDateTime = 'Next week';
  } else if (lower.includes('this morning')) {
    finalDateTime = 'Today morning';
  } else if (lower.includes('this afternoon')) {
    finalDateTime = 'Today afternoon';
  } else if (lower.includes('this evening') || lower.includes('tonight')) {
    finalDateTime = 'Today evening';
  }

  return finalDateTime;
}

async function getJerryResponse(phone, message, conversation) {
  const lowerMsg = message.toLowerCase();

  // STOP handling
  if (lowerMsg.includes('stop')) {
    await updateConversation(conversation.id, { status: 'stopped' });
    await logAnalytics('conversation_stopped', phone, { message });
    return "You've been unsubscribed. Reply START if you ever want to chat again.";
  }

  // START / resume
  if (lowerMsg.includes('start') && conversation.status === 'stopped') {
    await updateConversation(conversation.id, { status: 'active' });
    await logAnalytics('conversation_resumed', phone, { message });
    return "Welcome back! What type of vehicle are you most interested in? (SUV, Truck, Sedan, etc.)";
  }

  // Location / dealership info
  if (
    lowerMsg.includes('location') ||
    lowerMsg.includes('where') ||
    lowerMsg.includes('address') ||
    lowerMsg.includes('dealership') ||
    lowerMsg.includes('calgary') ||
    lowerMsg.includes('alberta')
  ) {
    return 'We are based in Calgary, Alberta and we can deliver vehicles all across Canada. If you’d like exact directions or store details, I can also have a manager call you.';
  }

  // Manager / call / more info
  if (
    lowerMsg.includes('manager') ||
    lowerMsg.includes('call') ||
    lowerMsg.includes('more info') ||
    lowerMsg.includes('details')
  ) {
    await updateConversation(conversation.id, { intent: 'callback' });
    return "No problem! What's the best time for a quick call? (e.g. Tomorrow at 2pm, Friday morning, This evening)";
  }

  // Capture name if provided mid-flow
  const maybeName = extractNameFromMessage(message);
  if (maybeName) {
    await updateConversation(conversation.id, {
      customer_name: maybeName,
    });
    await pool.query(
      'UPDATE customers SET name = $1, last_contact = CURRENT_TIMESTAMP WHERE phone = $2',
      [maybeName, phone]
    );

    if (conversation.intent === 'testdrive') {
      return `Nice to meet you, ${maybeName}! When works best for your test drive? (e.g. Tomorrow afternoon, Saturday morning, Next week)`;
    }
    return `Nice to meet you, ${maybeName}! What time works best for a quick call? (e.g. Tomorrow at 2pm, Friday morning, This evening)`;
  }

  // Default stage
  const stage = conversation.stage || 'greeting';
  let vehicleType = conversation.vehicle_type;
  let budget = conversation.budget;
  let intent = conversation.intent;
  let datetime = conversation.datetime;
  const name = conversation.customer_name || 'there';

  // Keyword: inventory / photos
  if (
    lowerMsg.includes('inventory') ||
    lowerMsg.includes('photos') ||
    lowerMsg.includes('pictures') ||
    lowerMsg.includes('see vehicles')
  ) {
    return `Great question! I’ll have one of our managers text you photos of ${vehicleType || 'vehicles'} in your budget range. They’ll reach out shortly.`;
  }

  // Handle stages
  if (stage === 'greeting' || !vehicleType) {
    if (lowerMsg.includes('suv')) {
      vehicleType = 'SUV';
    } else if (lowerMsg.includes('truck')) {
      vehicleType = 'Truck';
    } else if (lowerMsg.includes('sedan')) {
      vehicleType = 'Sedan';
    }

    if (vehicleType) {
      await updateConversation(conversation.id, {
        vehicle_type: vehicleType,
        stage: 'budget',
      });
      await logAnalytics('vehicle_type_selected', phone, { vehicleType });
      return `Great choice on a ${vehicleType}! What budget range are you thinking? (e.g. 15k, 25k, 40k, 60k)`;
    }

    return 'Awesome, I can help with that. What type of vehicle are you most interested in? (SUV, Truck, Sedan, etc.)';
  }

  if (stage === 'budget' || !budget) {
    const budgetAmount = extractBudget(message);

    if (!budgetAmount) {
      return 'Got it. To narrow things down, roughly what budget range are you thinking? (e.g. 15k, 25k, 40k, 60k)';
    }

    budget = `$${budgetAmount.toLocaleString('en-CA')}`;
    await updateConversation(conversation.id, {
      budget,
      budget_amount: budgetAmount,
      stage: 'intent',
    });
    await logAnalytics('budget_captured', phone, { budgetAmount });

    return `Perfect, I’ll focus on options around ${budget}. Would you prefer to book a quick test drive or have a manager give you a call first?`;
  }

  if (stage === 'intent' || !intent) {
    if (lowerMsg.includes('test drive') || lowerMsg.includes('testdrive') || lowerMsg.includes('drive')) {
      intent = 'testdrive';
      await updateConversation(conversation.id, {
        intent,
        stage: 'datetime',
      });
      await logAnalytics('intent_testdrive', phone, {});
      return `Awesome! When works best for your test drive? (e.g. Tomorrow afternoon, Saturday morning, Next week)`;
    }

    if (lowerMsg.includes('call') || lowerMsg.includes('phone')) {
      intent = 'callback';
      await updateConversation(conversation.id, {
        intent,
        stage: 'datetime',
      });
      await logAnalytics('intent_callback', phone, {});
      return `No problem! What time works best for a quick call? (e.g. Tomorrow at 2pm, Friday morning, This evening)`;
    }

    return 'Would you like to book a quick test drive or have a manager give you a call first?';
  }

  if (stage === 'datetime' || !datetime) {
    const finalDateTime = normalizeVagueDatetime(message);

    await updateConversation(conversation.id, {
      datetime: finalDateTime,
      stage: 'confirmed',
      status: 'converted',
    });

    const appointmentData = {
      phone,
      name,
      vehicleType: vehicleType || null,
      budget: budget || null,
      budgetAmount: conversation.budget_amount || null,
      datetime: finalDateTime,
    };

    if (intent === 'testdrive') {
      await saveAppointment(appointmentData);
      await logAnalytics('appointment_booked', phone, appointmentData);

      try {
        await sendEmailNotification(
          `Test Drive - ${name}`,
          `
            <div style="font-family: Arial, sans-serif">
              <h1 style="color:#10b981;">New Test Drive Booking</h1>
              <p><strong>Customer:</strong> ${name}</p>
              <p><strong>Phone:</strong> ${formatPhone(phone)}</p>
              <p><strong>Vehicle:</strong> ${vehicleType || 'Not specified'}</p>
              <p><strong>Budget:</strong> ${budget || 'Not specified'}</p>
              <p><strong>Date/Time:</strong> ${finalDateTime}</p>
            </div>
          `
        );
      } catch (_) {
        // email failure is non-fatal
      }

      return `Perfect ${name}! I’ve booked your test drive for "${finalDateTime}". We’re in Calgary, Alberta and we can deliver across Canada. You’ll also get a confirmation from our team. Reply STOP to opt out.`;
    }

    // default: callback
    await saveCallback(appointmentData);
    await logAnalytics('callback_requested', phone, appointmentData);

    try {
      await sendEmailNotification(
        `Callback - ${name}`,
        `
          <div style="font-family: Arial, sans-serif">
            <h1 style="color:#f59e0b;">Callback Requested</h1>
            <p><strong>Customer:</strong> ${name}</p>
            <p><strong>Phone:</strong> ${formatPhone(phone)}</p>
            <p><strong>Preferred time:</strong> ${finalDateTime}</p>
            <p><strong>Vehicle:</strong> ${vehicleType || 'Not specified'}</p>
            <p><strong>Budget:</strong> ${budget || 'Not specified'}</p>
          </div>
        `
      );
    } catch (_) {
      // email failure is non-fatal
    }

    return `Got it ${name}! One of our managers will call you around "${finalDateTime}" with options that fit your budget. Reply STOP to opt out.`;
  }

  // Confirmed stage: handle reschedule / cancel / inventory
  if (stage === 'confirmed') {
    if (
      lowerMsg.includes('reschedule') ||
      lowerMsg.includes('change') ||
      lowerMsg.includes('different time')
    ) {
      await updateConversation(conversation.id, { stage: 'datetime' });
      return 'No problem at all. What time works better for you? (e.g. Friday afternoon, Next Tuesday, This weekend)';
    }

    if (lowerMsg.includes('cancel')) {
      await updateConversation(conversation.id, { status: 'cancelled' });
      await logAnalytics('appointment_cancelled', phone, {});
      return "No worries, I’ve cancelled that for you. If you change your mind, just text me again and we’ll set something up.";
    }

    if (
      lowerMsg.includes('inventory') ||
      lowerMsg.includes('photos') ||
      lowerMsg.includes('pictures') ||
      lowerMsg.includes('see vehicles')
    ) {
      return `Great! I’ll have one of our managers text you photos of ${vehicleType || 'vehicles'} in your budget range. They’ll reach out shortly.`;
    }

    return `Thanks ${name}! You’re confirmed for "${datetime}". If you want to reschedule, just say RESCHEDULE.`;
  }

  // Fallback
  return `Thanks ${name}! I’ve noted that. If you want to book a test drive or a quick call, just mention "test drive" or "call" and I’ll help you set it up.`;
}

// ===== ROUTES =====

// Health check
app.get('/', (req, res) => {
  res.json({
    status: '✅ Jerry AI Backend LIVE - Database Edition',
    database: '✅ PostgreSQL Connected (see logs for any errors)',
    endpoints: {
      startSms: '/api/start-sms',
      webhook: '/api/sms-webhook',
      dashboard: '/dashboard',
      apiDashboard: '/api/dashboard',
      conversations: '/api/conversations',
      conversation: '/api/conversation/:phone',
      deleteConversation: 'DELETE /api/conversation/:phone',
      manualReply: 'POST /api/manual-reply',
      testEmail: '/test-email',
      exportAppointments: '/api/export/appointments',
      exportCallbacks: '/api/export/callbacks',
      exportConversations: '/api/export/conversations',
      exportAnalytics: '/api/export/analytics',
      analyticsSummary: '/api/analytics',
    },
    timestamp: new Date(),
  });
});

// ===== DASHBOARD HTML (simplified but functional) =====

app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Jerry AI - First Financial Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: linear-gradient(135deg, #1e3a5f 0, #2c4e6f 100%);
    min-height: 100vh;
    padding: 20px;
    color: #111827;
  }
  .container {
    max-width: 1400px;
    margin: 0 auto;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
    color: #fff;
  }
  h1 { font-size: 1.8rem; }
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 16px;
    margin-bottom: 20px;
  }
  .stat-card {
    background: #fff;
    border-radius: 10px;
    padding: 14px 18px;
    box-shadow: 0 2px 5px rgba(0,0,0,0.08);
    text-align: center;
  }
  .stat-card h3 {
    font-size: 0.8rem;
    text-transform: uppercase;
    color: #6b7280;
    margin-bottom: 6px;
  }
  .stat-card .number {
    font-size: 1.6rem;
    font-weight: 700;
    color: #111827;
  }
  .section {
    background: #fff;
    border-radius: 10px;
    padding: 18px 20px;
    margin-bottom: 20px;
    box-shadow: 0 2px 6px rgba(0,0,0,0.06);
  }
  .section h2 {
    font-size: 1.1rem;
    margin-bottom: 10px;
    border-bottom: 2px solid #1e3a5f;
    padding-bottom: 6px;
    color: #111827;
  }
  .launch-form {
    display: grid;
    gap: 10px;
    max-width: 520px;
  }
  .form-group label {
    display: block;
    margin-bottom: 4px;
    font-size: 0.9rem;
    color: #111827;
    font-weight: 600;
  }
  .form-group input,
  .form-group textarea {
    width: 100%;
    padding: 10px;
    border-radius: 8px;
    border: 1px solid #d1d5db;
    font-size: 0.95rem;
  }
  .form-group input:focus,
  .form-group textarea:focus {
    outline: none;
    border-color: #1e3a5f;
  }
  .btn-primary {
    background: #1e3a5f;
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 10px 20px;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
  }
  .btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .message-result,
  .reply-status {
    margin-top: 8px;
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 0.85rem;
    display: none;
  }
  .message-result.success,
  .reply-status.success {
    background: #d1fae5;
    color: #065f46;
  }
  .message-result.error,
  .reply-status.error {
    background: #fee2e2;
    color: #991b1b;
  }
  .flex {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }
  .conversation-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 420px;
    overflow-y: auto;
  }
  .conversation-item {
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 10px 12px;
    cursor: pointer;
    background: #f9fafb;
  }
  .conversation-item:hover {
    background: #eff6ff;
    border-color: #1d4ed8;
  }
  .conversation-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .conversation-header .phone {
    font-weight: 600;
    font-size: 0.95rem;
  }
  .conversation-header .name {
    margin-left: 6px;
    color: #1e3a5f;
    font-size: 0.85rem;
  }
  .conversation-header .badge {
    font-size: 0.75rem;
    padding: 2px 8px;
    border-radius: 999px;
    background: #e5e7eb;
    color: #111827;
  }
  .conversation-meta {
    font-size: 0.8rem;
    color: #6b7280;
    margin-top: 4px;
  }
  .messages-container {
    margin-top: 10px;
    border-radius: 8px;
    border: 1px solid #e5e7eb;
    background: #f9fafb;
    padding: 10px;
    max-height: 420px;
    overflow-y: auto;
  }
  .message {
    margin-bottom: 8px;
    padding: 7px 9px;
    border-radius: 8px;
    max-width: 80%;
    font-size: 0.85rem;
  }
  .message.user {
    margin-left: auto;
    background: #dbeafe;
    text-align: right;
  }
  .message.assistant {
    background: #fff;
    border: 1px solid #e5e7eb;
  }
  .message .role {
    font-weight: 600;
    font-size: 0.7rem;
    text-transform: uppercase;
    margin-bottom: 3px;
    color: #6b7280;
  }
  .message .time {
    font-size: 0.7rem;
    margin-top: 3px;
    color: #9ca3af;
  }
  .reply-form {
    margin-top: 8px;
    border-top: 1px solid #e5e7eb;
    padding-top: 8px;
  }
  .reply-input-group {
    display: flex;
    gap: 8px;
  }
  .reply-input {
    flex: 1;
    padding: 8px;
    border-radius: 6px;
    border: 1px solid #d1d5db;
    font-size: 0.85rem;
  }
  .small-list {
    max-height: 220px;
    overflow-y: auto;
  }
  .mini-card {
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 8px 10px;
    margin-bottom: 6px;
    background: #f9fafb;
    font-size: 0.8rem;
  }
  .mini-card-title {
    font-weight: 600;
    margin-bottom: 2px;
  }
  .empty {
    font-size: 0.85rem;
    color: #9ca3af;
    font-style: italic;
    padding: 8px 0;
  }
  .export-links a {
    display: inline-block;
    margin-right: 8px;
    margin-bottom: 6px;
    font-size: 0.85rem;
    text-decoration: none;
    background: #e5e7eb;
    padding: 6px 8px;
    border-radius: 6px;
    color: #111827;
  }
  .export-links a:hover {
    background: #d1d5db;
  }
  @media (max-width: 900px) {
    .flex {
      flex-direction: column;
    }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <div style="display:flex;align-items:center;gap:12px;">
      <div style="font-size:2rem;">🚗</div>
      <div>
        <h1>First Financial SMS Dashboard</h1>
        <div style="font-size:0.85rem;color:#e5e7eb;">Jerry AI - Conversation & Appointment Hub</div>
      </div>
    </div>
    <div style="font-size:0.8rem;color:#e5e7eb;">${new Date().toLocaleString()}</div>
  </header>

  <div class="stats">
    <div class="stat-card">
      <h3>Total Customers</h3>
      <div class="number" id="totalCustomers">0</div>
    </div>
    <div class="stat-card">
      <h3>Conversations</h3>
      <div class="number" id="totalConversations">0</div>
    </div>
    <div class="stat-card">
      <h3>Messages</h3>
      <div class="number" id="totalMessages">0</div>
    </div>
    <div class="stat-card">
      <h3>Appointments</h3>
      <div class="number" id="totalAppointments">0</div>
    </div>
    <div class="stat-card">
      <h3>Callbacks</h3>
      <div class="number" id="totalCallbacks">0</div>
    </div>
  </div>

  <div class="section">
    <h2>Analytics</h2>
    <div class="stats">
      <div class="stat-card">
        <h3>Conversion Rate</h3>
        <div class="number" id="conversionRate">0.0%</div>
      </div>
      <div class="stat-card">
        <h3>Response Rate</h3>
        <div class="number" id="responseRate">0.0%</div>
      </div>
      <div class="stat-card">
        <h3>Avg Msg / Conv</h3>
        <div class="number" id="avgMessages">0.0</div>
      </div>
      <div class="stat-card">
        <h3>Convs Last 7 Days</h3>
        <div class="number" id="weekConversations">0</div>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>Launch SMS Campaign</h2>
    <form class="launch-form" id="launchForm">
      <div class="form-group">
        <label for="phoneNumber">Phone Number</label>
        <input type="tel" id="phoneNumber" placeholder="1 403 555-0100" required />
      </div>
      <div class="form-group">
        <label for="message">Message</label>
        <textarea id="message" rows="3">Hi! I'm Jerry from the dealership. I wanted to reach out and see if you're interested in finding your perfect vehicle. What type of car are you looking for? Reply STOP to opt out.</textarea>
      </div>
      <button type="submit" class="btn-primary" id="sendBtn">Send Message</button>
      <div id="messageResult" class="message-result"></div>
    </form>
  </div>

  <div class="section">
    <h2>Conversations & Messages</h2>
    <div class="flex">
      <div style="flex:1;min-width:260px;">
        <input id="searchBox" placeholder="Search by phone or name..." style="width:100%;padding:8px;border-radius:8px;border:1px solid #d1d5db;font-size:0.9rem;margin-bottom:8px;" />
        <div class="conversation-list" id="conversationList">
          <div class="empty">Loading conversations...</div>
        </div>
      </div>
      <div style="flex:2;min-width:300px;">
        <div class="messages-container" id="messagesContainer" style="display:none;"></div>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>Recent Appointments & Callbacks</h2>
    <div class="flex">
      <div style="flex:1;min-width:260px;">
        <h3 style="font-size:0.9rem;margin-bottom:4px;">Appointments</h3>
        <div id="appointmentsList" class="small-list">
          <div class="empty">Loading...</div>
        </div>
      </div>
      <div style="flex:1;min-width:260px;">
        <h3 style="font-size:0.9rem;margin-bottom:4px;">Callbacks</h3>
        <div id="callbacksList" class="small-list">
          <div class="empty">Loading...</div>
        </div>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>Exports</h2>
    <div class="export-links">
      <a href="/api/export/appointments" target="_blank">Appointments CSV</a>
      <a href="/api/export/callbacks" target="_blank">Callbacks CSV</a>
      <a href="/api/export/conversations" target="_blank">Conversations CSV</a>
      <a href="/api/export/analytics" target="_blank">Analytics CSV</a>
    </div>
  </div>
</div>

<script>
  function cleanPhoneForId(phone) {
    return (phone || '').replace(/\\D/g, '');
  }

  document.getElementById('phoneNumber').addEventListener('input', function (e) {
    let value = e.target.value.replace(/\\D/g, '');
    if (value.length > 11) value = value.slice(0, 11);
    if (!value.startsWith('1')) value = '1' + value;

    let formatted = '';
    if (value.length > 0) formatted = value.substring(0, 1);
    if (value.length > 1) formatted += ' ' + value.substring(1, 4);
    if (value.length > 4) formatted += ' ' + value.substring(4, 7);
    if (value.length > 7) formatted += '-' + value.substring(7, 11);
    e.target.value = formatted;
  });

  document.getElementById('launchForm').addEventListener('submit', async function (event) {
    event.preventDefault();
    const phoneNumber = document.getElementById('phoneNumber').value.replace(/\\D/g, '');
    const fullPhone = phoneNumber.startsWith('1') ? phoneNumber : '1' + phoneNumber;
    const customMessage = document.getElementById('message').value.trim();
    const sendBtn = document.getElementById('sendBtn');
    const resultDiv = document.getElementById('messageResult');

    if (!fullPhone) return;

    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending...';
    resultDiv.style.display = 'none';

    try {
      const response = await fetch('/api/start-sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: fullPhone, message: customMessage }),
      });
      const data = await response.json();
      if (data.success) {
        resultDiv.className = 'message-result success';
        resultDiv.textContent = 'SMS sent successfully to ' + fullPhone;
        document.getElementById('phoneNumber').value = '';
        setTimeout(loadDashboard, 800);
      } else {
        throw new Error(data.error || 'Failed to send SMS');
      }
    } catch (err) {
      resultDiv.className = 'message-result error';
      resultDiv.textContent = 'Error: ' + err.message;
    } finally {
      resultDiv.style.display = 'block';
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send Message';
    }
  });

  async function sendManualReply(phone, inputId, btnId, statusId) {
    const input = document.getElementById(inputId);
    const btn = document.getElementById(btnId);
    const status = document.getElementById(statusId);
    const message = (input.value || '').trim();
    if (!message) return;

    btn.disabled = true;
    btn.textContent = 'Sending...';
    status.style.display = 'none';

    try {
      const response = await fetch('/api/manual-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, message }),
      });
      const data = await response.json();
      if (data.success) {
        status.className = 'reply-status success';
        status.textContent = 'Reply sent!';
        input.value = '';
        setTimeout(() => {
          viewConversation(phone);
          status.style.display = 'none';
        }, 800);
      } else {
        throw new Error(data.error || 'Failed to send reply');
      }
    } catch (err) {
      status.className = 'reply-status error';
      status.textContent = err.message;
    } finally {
      status.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Send Reply';
    }
  }

  async function deleteConversation(phone, event) {
    event.stopPropagation();
    if (!confirm('Are you sure you want to delete this conversation? This cannot be undone.')) return;

    try {
      const response = await fetch('/api/conversation/' + encodeURIComponent(phone), {
        method: 'DELETE',
      });
      const data = await response.json();
      if (data.success) {
        loadDashboard();
      } else {
        alert('Error deleting conversation: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      alert('Error deleting conversation: ' + err.message);
    }
  }

  async function viewConversation(phone) {
    const messagesContainer = document.getElementById('messagesContainer');
    messagesContainer.style.display = 'block';
    messagesContainer.innerHTML = '<div class="empty">Loading messages...</div>';

    try {
      const res = await fetch('/api/conversation/' + encodeURIComponent(phone));
      const data = await res.json();
      if (data.error) {
        messagesContainer.innerHTML = '<div class="empty">Error loading messages</div>';
        return;
      }
      const conv = data.conversation;
      const messages = data.messages || [];
      const cleanPhone = cleanPhoneForId(phone);
      const inputId = 'reply-input-' + cleanPhone;
      const btnId = 'reply-btn-' + cleanPhone;
      const statusId = 'reply-status-' + cleanPhone;

      const msgsHtml = messages
        .map((m) => {
          const roleLabel = m.role === 'user' ? 'Customer' : 'Jerry AI';
          const created = m.created_at ? new Date(m.created_at) : null;
          const timeStr = created ? created.toLocaleString() : '';
          return (
            '<div class="message ' + m.role + '">' +
            '<div class="role">' + roleLabel + '</div>' +
            '<div>' + (m.content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>' +
            '<div class="time">' + timeStr + '</div>' +
            '</div>'
          );
        })
        .join('');

      messagesContainer.innerHTML =
        '<div style="font-size:0.9rem;font-weight:600;margin-bottom:6px;">Conversation with ' +
        (conv.customer_name || '') +
        ' ' +
        '(' + phone + ')' +
        '</div>' +
        (msgsHtml || '<div class="empty">No messages yet.</div>') +
        '<div class="reply-form">' +
        '<div style="font-size:0.85rem;margin-bottom:4px;">Send Manual Reply</div>' +
        '<div class="reply-input-group">' +
        '<input id="' + inputId + '" class="reply-input" placeholder="Type your message..." />' +
        '<button id="' + btnId + '" class="btn-primary" style="padding:7px 12px;font-size:0.8rem;">Send</button>' +
        '</div>' +
        '<div id="' + statusId + '" class="reply-status"></div>' +
        '</div>';

      document.getElementById(btnId).addEventListener('click', function () {
        sendManualReply(phone, inputId, btnId, statusId);
      });
    } catch (err) {
      messagesContainer.innerHTML = '<div class="empty">Error loading messages</div>';
    }
  }

  function filterConversations() {
    const searchTerm = document.getElementById('searchBox').value.toLowerCase();
    const items = document.querySelectorAll('.conversation-item');
    items.forEach((item) => {
      const phone = (item.getAttribute('data-phone') || '').toLowerCase();
      const name = (item.getAttribute('data-name') || '').toLowerCase();
      if (!searchTerm || phone.includes(searchTerm) || name.includes(searchTerm)) {
        item.style.display = '';
      } else {
        item.style.display = 'none';
      }
    });
  }

  document.getElementById('searchBox').addEventListener('keyup', filterConversations);

  async function loadDashboard() {
    try {
      const statsRes = await fetch('/api/dashboard');
      const statsData = await statsRes.json();

      if (!statsData.error && statsData.stats) {
        document.getElementById('totalCustomers').textContent = statsData.stats.totalCustomers;
        document.getElementById('totalConversations').textContent = statsData.stats.totalConversations;
        document.getElementById('totalMessages').textContent = statsData.stats.totalMessages;
        document.getElementById('totalAppointments').textContent = statsData.stats.totalAppointments;
        document.getElementById('totalCallbacks').textContent = statsData.stats.totalCallbacks;

        const aptList = document.getElementById('appointmentsList');
        if (!statsData.recentAppointments || !statsData.recentAppointments.length) {
          aptList.innerHTML = '<div class="empty">No appointments yet.</div>';
        } else {
          aptList.innerHTML = statsData.recentAppointments
            .map((a) =>
              '<div class="mini-card">' +
              '<div class="mini-card-title">' + (a.customer_name || 'Unknown') + '</div>' +
              '<div>' + (a.datetime || '') + '</div>' +
              '<div>' + (a.vehicle_type || '') + ' | ' + (a.budget || '') + '</div>' +
              '</div>'
            )
            .join('');
        }

        const cbList = document.getElementById('callbacksList');
        if (!statsData.recentCallbacks || !statsData.recentCallbacks.length) {
          cbList.innerHTML = '<div class="empty">No callbacks yet.</div>';
        } else {
          cbList.innerHTML = statsData.recentCallbacks
            .map((c) =>
              '<div class="mini-card">' +
              '<div class="mini-card-title">' + (c.customer_name || 'Unknown') + '</div>' +
              '<div>' + (c.datetime || '') + '</div>' +
              '<div>' + (c.vehicle_type || '') + ' | ' + (c.budget || '') + '</div>' +
              '</div>'
            )
            .join('');
        }
      }

      const convRes = await fetch('/api/conversations');
      const conversations = await convRes.json();
      const convList = document.getElementById('conversationList');

      if (!conversations || !conversations.length || conversations.error) {
        convList.innerHTML = '<div class="empty">No conversations yet.</div>';
      } else {
        const unique = {};
        conversations.forEach((c) => {
          if (!c.customer_phone) return;
          const key = c.customer_phone;
          if (!unique[key]) {
            unique[key] = c;
          } else {
            const d1 = new Date(c.updated_at);
            const d2 = new Date(unique[key].updated_at);
            if (d1 > d2) unique[key] = c;
          }
        });
        const arr = Object.values(unique);
        convList.innerHTML = arr
          .map((c) => {
            const phone = c.customer_phone;
            const name = c.customer_name || 'Unknown';
            const status = c.status || 'active';
            const vehicle = c.vehicle_type || 'No vehicle';
            const budget = c.budget || 'No budget';
            const started = c.started_at ? new Date(c.started_at).toLocaleString() : '';
            const msgCount = c.messagecount || 0;
            return (
              '<div class="conversation-item" data-phone="' + phone + '" data-name="' + name +
              '" onclick="viewConversation(\\'' + phone + '\\')">' +
              '<div class="conversation-header">' +
              '<div><span class="phone">' + phone + '</span>' +
              '<span class="name"> • ' + name + '</span></div>' +
              '<div><span class="badge">' + status + '</span>' +
              ' <button style="margin-left:6px;font-size:0.7rem;padding:2px 6px;border-radius:999px;border:none;background:#ef4444;color:#fff;cursor:pointer;" onclick="deleteConversation(\\'' + phone + '\\', event)">X</button>' +
              '</div>' +
              '</div>' +
              '<div class="conversation-meta">' +
              vehicle + ' | ' + budget + ' | ' + msgCount + ' messages | Started ' + started +
              '</div>' +
              '</div>'
            );
          })
          .join('');
      }

      const analyticsRes = await fetch('/api/analytics');
      const analyticsData = await analyticsRes.json();
      if (!analyticsData.error) {
        document.getElementById('conversionRate').textContent =
          (analyticsData.conversionRate || '0.0') + '%';
        document.getElementById('responseRate').textContent =
          (analyticsData.responseRate || '0.0') + '%';
        document.getElementById('avgMessages').textContent =
          (analyticsData.avgMessages || '0.0');
        document.getElementById('weekConversations').textContent =
          analyticsData.weekConversations || 0;
      }
    } catch (err) {
      console.error('Dashboard load error', err);
    }
  }

  loadDashboard();
  setInterval(loadDashboard, 25000);
</script>
</body>
</html>`);
});

// ===== API: START SMS CAMPAIGN =====

app.post('/api/start-sms', async (req, res) => {
  try {
    const { phone, message } = req.body || {};
    if (!phone) {
      return res.json({ success: false, error: 'Phone number required' });
    }

    if (await hasActiveConversation(phone)) {
      return res.json({
        success: false,
        error:
          'This customer already has an active conversation. Use the dashboard to continue.',
      });
    }

    const messageBody =
      message ||
      "Hi! I'm Jerry from the dealership. I wanted to reach out and see if you're interested in finding your perfect vehicle. What type of car are you looking for? Reply STOP to opt out.";

    await getOrCreateCustomer(phone);
    const conversation = await getOrCreateConversation(phone);

    await saveMessage(conversation.id, phone, 'assistant', messageBody);
    await logAnalytics('sms_sent', phone, { message: messageBody });

    if (twilioClient && twilioFromNumber) {
      await twilioClient.messages.create({
        body: messageBody,
        from: twilioFromNumber,
        to: phone,
      });
      console.log('📲 SMS sent to', phone);
    } else {
      console.log('⚠️ Twilio not configured, skipping actual SMS send');
    }

    res.json({ success: true, message: 'SMS sent!' });
  } catch (error) {
    console.error('❌ Error sending SMS:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// ===== API: TWILIO WEBHOOK (INCOMING SMS) =====

app.post('/api/sms-webhook', (req, res) => {
  const phone = req.body.From;
  const message = req.body.Body || '';

  console.log('📥 Incoming SMS from', phone);
  console.log('Message:', message);

  // Respond to Twilio immediately to prevent retries
  res.type('text/xml').send('<Response></Response>');

  // Do all processing asynchronously
  (async () => {
    try {
      await getOrCreateCustomer(phone);
      const conversation = await getOrCreateConversation(phone);

      await saveMessage(conversation.id, phone, 'user', message);
      await touchConversation(conversation.id);
      await logAnalytics('message_received', phone, { message });

      const updatedConvRes = await pool.query(
        'SELECT * FROM conversations WHERE id = $1',
        [conversation.id]
      );
      const latestConv = updatedConvRes.rows[0] || conversation;

      const aiResponse = await getJerryResponse(phone, message, latestConv);
      await saveMessage(conversation.id, phone, 'assistant', aiResponse);

      if (twilioClient && twilioFromNumber) {
        await twilioClient.messages.create({
          body: aiResponse,
          from: twilioFromNumber,
          to: phone,
        });
        console.log('🤖 Jerry replied to', phone);
      }

      // Email notification (non-blocking for Twilio)
      try {
        await sendEmailNotification(
          `New SMS from ${latestConv.customer_name || phone}`,
          `
            <div style="font-family: Arial, sans-serif">
              <h1>New SMS Conversation</h1>
              <p><strong>From:</strong> ${latestConv.customer_name || 'Unknown'} (${formatPhone(
                phone
              )})</p>
              <p><strong>Customer message:</strong> ${message}</p>
              <p><strong>Jerry reply:</strong> ${aiResponse}</p>
            </div>
          `
        );
      } catch (_) {}
    } catch (err) {
      console.error('❌ Error processing incoming SMS:', err.message);
    }
  })();
});

// ===== API: CONVERSATION HISTORY =====

app.get('/api/conversation/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    const convRes = await pool.query(
      'SELECT * FROM conversations WHERE customer_phone = $1 ORDER BY started_at DESC LIMIT 1',
      [phone]
    );
    if (convRes.rows.length === 0) {
      return res.json({ error: 'No conversation found' });
    }
    const conversation = convRes.rows[0];

    const msgRes = await pool.query(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [conversation.id]
    );

    res.json({ conversation, messages: msgRes.rows });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// ===== API: DELETE CONVERSATION =====

app.delete('/api/conversation/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    const deleted = await deleteConversationByPhone(phone);
    if (deleted) {
      res.json({ success: true, message: 'Conversation deleted' });
    } else {
      res.json({ success: false, error: 'Conversation not found' });
    }
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ===== API: DELETE APPOINTMENT / CALLBACK (server-side) =====

app.delete('/api/appointment/:id', async (req, res) => {
  try {
    const id = req.params.id;
    await pool.query('DELETE FROM appointments WHERE id = $1', [id]);
    console.log('🗑️ Appointment deleted', id);
    res.json({ success: true, message: 'Appointment deleted' });
  } catch (error) {
    console.error('Error deleting appointment:', error.message);
    res.json({ success: false, error: error.message });
  }
});

app.delete('/api/callback/:id', async (req, res) => {
  try {
    const id = req.params.id;
    await pool.query('DELETE FROM callbacks WHERE id = $1', [id]);
    console.log('🗑️ Callback deleted', id);
    res.json({ success: true, message: 'Callback deleted' });
  } catch (error) {
    console.error('Error deleting callback:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// ===== API: MANUAL REPLY =====

app.post('/api/manual-reply', async (req, res) => {
  try {
    const { phone, message } = req.body || {};
    if (!phone || !message) {
      return res.json({ success: false, error: 'Phone and message required' });
    }

    const conversation = await getOrCreateConversation(phone);
    await saveMessage(conversation.id, phone, 'assistant', message);
    await touchConversation(conversation.id);
    await logAnalytics('manual_reply_sent', phone, { message });

    if (twilioClient && twilioFromNumber) {
      await twilioClient.messages.create({
        body: message,
        from: twilioFromNumber,
        to: phone,
      });
      console.log('✍️ Manual reply sent to', phone);
    }

    res.json({ success: true, message: 'Reply sent!' });
  } catch (error) {
    console.error('❌ Error sending manual reply:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// ===== API: DASHBOARD STATS =====

app.get('/api/dashboard', async (req, res) => {
  try {
    const customers = await pool.query('SELECT COUNT(*) AS count FROM customers');
    const conversations = await pool.query('SELECT COUNT(*) AS count FROM conversations');
    const messages = await pool.query('SELECT COUNT(*) AS count FROM messages');

    const appointments = await pool.query(
      'SELECT * FROM appointments ORDER BY created_at DESC LIMIT 25'
    );
    const callbacks = await pool.query(
      'SELECT * FROM callbacks ORDER BY created_at DESC LIMIT 25'
    );

    res.json({
      stats: {
        totalCustomers: parseInt(customers.rows[0].count, 10) || 0,
        totalConversations: parseInt(conversations.rows[0].count, 10) || 0,
        totalMessages: parseInt(messages.rows[0].count, 10) || 0,
        totalAppointments: appointments.rows.length,
        totalCallbacks: callbacks.rows.length,
      },
      recentAppointments: appointments.rows,
      recentCallbacks: callbacks.rows,
    });
  } catch (error) {
    console.error('❌ Dashboard stats error:', error.message);
    res.json({ error: error.message });
  }
});

// ===== API: ALL CONVERSATIONS (for dashboard) =====

app.get('/api/conversations', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        c.id,
        c.customer_phone,
        c.customer_name,
        c.stage,
        c.status,
        c.vehicle_type,
        c.budget,
        c.started_at,
        c.updated_at,
        (
          SELECT COUNT(*)
          FROM messages m
          WHERE m.conversation_id = c.id
        ) AS messageCount
      FROM conversations c
      ORDER BY c.updated_at DESC
      LIMIT 100
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Get conversations error:', error.message);
    res.json({ error: error.message });
  }
});

// ===== EXPORT ENDPOINTS (CSV) =====

app.get('/api/export/appointments', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM appointments ORDER BY created_at DESC');
    const rows = [
      ['ID', 'Phone', 'Name', 'Vehicle', 'Budget', 'Amount', 'DateTime', 'Created'].join(','),
    ];
    result.rows.forEach((r) =>
      rows.push(
        [
          r.id,
          `"${r.customer_phone || ''}"`,
          `"${r.customer_name || ''}"`,
          `"${r.vehicle_type || ''}"`,
          `"${r.budget || ''}"`,
          r.budget_amount || '',
          `"${r.datetime || ''}"`,
          `"${r.created_at || ''}"`,
        ].join(',')
      )
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="appointments_${new Date().toISOString().split('T')[0]}.csv"`
    );
    res.send(rows.join('\n'));
    console.log('📊 Exported', result.rows.length, 'appointments');
  } catch (e) {
    console.error('❌ Export appointments error:', e.message);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="appointments_error.csv"'
    );
    res.send(`Error,Message\n"Export Failed","${e.message}"`);
  } finally {
    client.release();
  }
});

app.get('/api/export/callbacks', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM callbacks ORDER BY created_at DESC');
    const rows = [
      ['ID', 'Phone', 'Name', 'Vehicle', 'Budget', 'Amount', 'DateTime', 'Created'].join(','),
    ];
    result.rows.forEach((r) =>
      rows.push(
        [
          r.id,
          `"${r.customer_phone || ''}"`,
          `"${r.customer_name || ''}"`,
          `"${r.vehicle_type || ''}"`,
          `"${r.budget || ''}"`,
          r.budget_amount || '',
          `"${r.datetime || ''}"`,
          `"${r.created_at || ''}"`,
        ].join(',')
      )
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="callbacks_${new Date().toISOString().split('T')[0]}.csv"`
    );
    res.send(rows.join('\n'));
    console.log('📊 Exported', result.rows.length, 'callbacks');
  } catch (e) {
    console.error('❌ Export callbacks error:', e.message);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="callbacks_error.csv"'
    );
    res.send(`Error,Message\n"Export Failed","${e.message}"`);
  } finally {
    client.release();
  }
});

app.get('/api/export/conversations', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM conversations ORDER BY started_at DESC');
    const rows = [
      ['ID', 'Phone', 'Status', 'Name', 'Vehicle', 'Budget', 'Started', 'Updated'].join(','),
    ];
    result.rows.forEach((r) =>
      rows.push(
        [
          r.id,
          `"${r.customer_phone || ''}"`,
          `"${r.status || ''}"`,
          `"${r.customer_name || ''}"`,
          `"${r.vehicle_type || ''}"`,
          `"${r.budget || ''}"`,
          `"${r.started_at || ''}"`,
          `"${r.updated_at || ''}"`,
        ].join(',')
      )
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="conversations_${new Date().toISOString().split('T')[0]}.csv"`
    );
    res.send(rows.join('\n'));
    console.log('📊 Exported', result.rows.length, 'conversations');
  } catch (e) {
    console.error('❌ Export conversations error:', e.message);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      'attachment: filename="conversations_error.csv"'
    );
    res.send(`Error,Message\n"Export Failed","${e.message}"`);
  } finally {
    client.release();
  }
});

app.get('/api/export/analytics', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM analytics ORDER BY timestamp DESC');
    const rows = ['ID,Event,Phone,Data,Timestamp'];
    result.rows.forEach((r) =>
      rows.push(
        [
          r.id,
          `"${r.event_type || ''}"`,
          `"${r.customer_phone || ''}"`,
          `"${JSON.stringify(r.data || {}).replace(/"/g, '""')}"`,
          `"${r.timestamp || ''}"`,
        ].join(',')
      )
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="analytics_${new Date().toISOString().split('T')[0]}.csv"`
    );
    res.send(rows.join('\n'));
    console.log('📊 Exported', result.rows.length, 'analytics events');
  } catch (e) {
    console.error('❌ Export analytics error:', e.message);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="analytics_error.csv"'
    );
    res.send(`Error,Message\n"Export Failed","${e.message}"`);
  } finally {
    client.release();
  }
});

// ===== API: ANALYTICS SUMMARY =====

app.get('/api/analytics', async (req, res) => {
  const client = await pool.connect();
  try {
    const totalConvs = await client.query('SELECT COUNT(*) AS count FROM conversations');
    const totalConversations = parseInt(totalConvs.rows[0].count, 10) || 0;

    const converted = await client.query(
      "SELECT COUNT(*) AS count FROM conversations WHERE status = 'converted'"
    );
    const totalConverted = parseInt(converted.rows[0].count, 10) || 0;

    const responded = await client.query(
      "SELECT COUNT(DISTINCT conversation_id) AS count FROM messages WHERE role = 'user'"
    );
    const totalResponded = parseInt(responded.rows[0].count, 10) || 0;

    const avgMsgs = await client.query(`
      SELECT COALESCE(AVG(msg_count), 0)::numeric(10,1) AS avg
      FROM (
        SELECT conversation_id, COUNT(*) AS msg_count
        FROM messages
        GROUP BY conversation_id
      ) counts
    `);
    const avgMessages = parseFloat(avgMsgs.rows[0].avg || 0);

    const weekConvs = await client.query(
      "SELECT COUNT(*) AS count FROM conversations WHERE started_at >= NOW() - INTERVAL '7 days'"
    );
    const weekConversations = parseInt(weekConvs.rows[0].count, 10) || 0;

    const weekConverted = await client.query(
      "SELECT COUNT(*) AS count FROM conversations WHERE status = 'converted' AND started_at >= NOW() - INTERVAL '7 days'"
    );
    const weekConvertedCount = parseInt(weekConverted.rows[0].count, 10) || 0;

    const topVehicles = await client.query(`
      SELECT vehicle_type, COUNT(*) AS count
      FROM conversations
      WHERE vehicle_type IS NOT NULL AND vehicle_type <> ''
      GROUP BY vehicle_type
      ORDER BY count DESC
      LIMIT 5
    `);

    const budgets = await client.query(`
      SELECT budget, COUNT(*) AS count
      FROM conversations
      WHERE budget IS NOT NULL AND budget <> ''
      GROUP BY budget
      ORDER BY count DESC
    `);

    res.json({
      conversionRate:
        totalConversations > 0
          ? ((totalConverted / totalConversations) * 100).toFixed(1)
          : '0.0',
      totalConverted,
      totalConversations,
      responseRate:
        totalConversations > 0
          ? ((totalResponded / totalConversations) * 100).toFixed(1)
          : '0.0',
      totalResponded,
      avgMessages: avgMessages.toFixed(1),
      weekConversations,
      weekConverted: weekConvertedCount,
      topVehicles: topVehicles.rows,
      budgetDist: budgets.rows,
    });
  } catch (error) {
    console.error('❌ Analytics error:', error.message);
    res.json({ error: error.message });
  } finally {
    client.release();
  }
});

// ===== API: TEST EMAIL =====

app.get('/test-email', async (req, res) => {
  try {
    const result = await sendEmailNotification(
      'Test Email - Jerry AI',
      `<h1>Email Working!</h1><p>Test at ${new Date().toLocaleString()}</p>`
    );
    res.json({
      success: result,
      message: result ? '✅ Email sent!' : '❌ Email not configured',
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ===== START SERVER =====

app.listen(PORT, HOST, () => {
  console.log(`✅ Jerry AI Backend - Database Edition - Port ${PORT}`);
});
