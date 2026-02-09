const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
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
  ssl: {
    rejectUnauthorized: false
  }
});

// Test database connection on startup
pool.connect()
  .then(() => console.log('✅ Database connected'))
  .catch(err => console.error('❌ Database connection error:', err));



// ===== EMAIL & HELPERS =====
const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD }
});

async function sendEmailNotification(subject, htmlContent) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    console.log('⚠️  Email not configured');
    return false;
  }
  try {
    const info = await emailTransporter.sendMail({
      from: '"Jerry AI - First Financial" <' + process.env.EMAIL_USER + '>',
      to: process.env.EMAIL_TO || 'firstfinancialcanada@gmail.com',
      subject: subject,
      html: htmlContent
    });
    console.log('📧 Email sent:', info.messageId);
    return true;
  } catch (error) {
    console.error('❌ Email error:', error.message);
    return false;
  }
}

function formatPhone(phone) {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    return '+1 (' + cleaned.slice(1,4) + ') ' + cleaned.slice(4,7) + '-' + cleaned.slice(7);
  }
  return phone;
}

// ===== DATABASE HELPER FUNCTIONS =====

// Get or create customer
async function getOrCreateCustomer(phone) {
  const client = await pool.connect();
  try {
    let result = await client.query(
      'SELECT * FROM customers WHERE phone = $1',
      [phone]
    );
    
    if (result.rows.length === 0) {
      result = await client.query(
        'INSERT INTO customers (phone) VALUES ($1) RETURNING *',
        [phone]
      );
      console.log('📝 New customer created:', phone);
    }
    
    return result.rows[0];
  } finally {
    client.release();
  }
}

// Get or create active conversation
async function getOrCreateConversation(phone) {
  const client = await pool.connect();
  try {
    let result = await client.query(
      'SELECT * FROM conversations WHERE customer_phone = $1 AND status = $2 ORDER BY started_at DESC LIMIT 1',
      [phone, 'active']
    );
    
    if (result.rows.length === 0) {
      result = await client.query(
        'INSERT INTO conversations (customer_phone) VALUES ($1) RETURNING *',
        [phone]
      );
      console.log('💬 New conversation started:', phone);
    } else {
      await client.query(
        'UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [result.rows[0].id]
      );
      console.log('💬 Continuing conversation:', phone);
    }
    
    return result.rows[0];
  } finally {
    client.release();
  }
}

// Update conversation data
async function updateConversation(conversationId, updates) {
  const client = await pool.connect();
  try {
    const fields = [];
    const values = [];
    let paramCount = 1;
    
    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }
    
    values.push(conversationId);
    
    await client.query(
      `UPDATE conversations SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramCount}`,
      values
    );
  } finally {
    client.release();
  }
}

// Update conversation timestamp
async function touchConversation(conversationId) {
  const client = await pool.connect();
  try {
    await client.query(
      'UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [conversationId]
    );
  } finally {
    client.release();
  }
}

// Check if customer already has an active conversation
async function hasActiveConversation(phone) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT id FROM conversations WHERE customer_phone = $1 AND status = $2 LIMIT 1',
      [phone, 'active']
    );
    return result.rows.length > 0;
  } finally {
    client.release();
  }
}

// Delete conversation and its messages
async function deleteConversation(phone) {
  const client = await pool.connect();
  try {
    const conversation = await client.query(
      'SELECT id FROM conversations WHERE customer_phone = $1 ORDER BY started_at DESC LIMIT 1',
      [phone]
    );
    
    if (conversation.rows.length > 0) {
      const conversationId = conversation.rows[0].id;
      
      await client.query('DELETE FROM messages WHERE conversation_id = $1', [conversationId]);
      await client.query('DELETE FROM conversations WHERE id = $1', [conversationId]);
      
      console.log('🗑️ Conversation deleted:', phone);
      return true;
    }
    
    return false;
  } finally {
    client.release();
  }
}

// Save message to database
async function saveMessage(conversationId, phone, role, content) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO messages (conversation_id, customer_phone, role, content) VALUES ($1, $2, $3, $4)',
      [conversationId, phone, role, content]
    );
  } finally {
    client.release();
  }
}

// Save appointment
async function saveAppointment(data) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO appointments (customer_phone, customer_name, vehicle_type, budget, budget_amount, datetime) VALUES ($1, $2, $3, $4, $5, $6)',
      [data.phone, data.name, data.vehicleType, data.budget, data.budgetAmount, data.datetime]
    );
    console.log('🚗 Appointment saved:', data.name);
  } finally {
    client.release();
  }
}

// Save callback
async function saveCallback(data) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO callbacks (customer_phone, customer_name, vehicle_type, budget, budget_amount, datetime) VALUES ($1, $2, $3, $4, $5, $6)',
      [data.phone, data.name, data.vehicleType, data.budget, data.budgetAmount, data.datetime]
    );
    console.log('📞 Callback saved:', data.name);
  } finally {
    client.release();
  }
}

// Log analytics event
async function logAnalytics(eventType, phone, data) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO analytics (event_type, customer_phone, data) VALUES ($1, $2, $3)',
      [eventType, phone, JSON.stringify(data)]
    );
  } finally {
    client.release();
  }
}

// ===== ROUTES =====

// Health check
app.get('/', (req, res) => {
  res.json({
    status: '✅ Jerry AI Backend LIVE - Database Edition',
    database: '✅ PostgreSQL Connected',
    endpoints: {
      startSms: '/api/start-sms',
      webhook: '/api/sms-webhook',
      dashboard: '/dashboard',
      apiDashboard: '/api/dashboard',
      conversations: '/api/conversations',
      conversation: '/api/conversation/:phone',
      deleteConversation: 'DELETE /api/conversation/:phone',
      manualReply: 'POST /api/manual-reply', testEmail: '/test-email', exportAppointments: '/api/export/appointments', exportCallbacks: '/api/export/callbacks', exportConversations: '/api/export/conversations', exportAnalytics: '/api/export/analytics'
    },
    timestamp: new Date()
  });
});

// Interactive HTML Dashboard
app.get('/dashboard', async (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Jerry AI Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1e3a5f 0%, #2c4e6f 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    h1 { color: white; margin-bottom: 30px; font-size: 2.5rem; text-align: center; }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .stat-card {
      background: white;
      padding: 25px;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      text-align: center;
    }
    .stat-card h3 { color: #1e3a5f; font-size: 0.9rem; margin-bottom: 10px; text-transform: uppercase; }
    .stat-card .number { font-size: 2.5rem; font-weight: bold; color: #333; }
    
    .section {
      background: white;
      padding: 30px;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      margin-bottom: 30px;
    }
    .section h2 { 
      color: #333; 
      margin-bottom: 20px; 
      border-bottom: 2px solid #1e3a5f; 
      padding-bottom: 10px; 
      font-size: 1.5rem;
    }
    
    .launch-form {
      display: grid;
      gap: 15px;
      max-width: 600px;
    }
    .form-group label {
      display: block;
      font-weight: 600;
      margin-bottom: 8px;
      color: #333;
    }
    .form-group input, .form-group textarea {
      width: 100%;
      padding: 12px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 1rem;
      font-family: inherit;
    }
    .form-group input:focus, .form-group textarea:focus {
      outline: none;
      border-color: #1e3a5f;
    }
    .form-group textarea {
      min-height: 120px;
      resize: vertical;
    }
    .btn-send {
      background: #1e3a5f;
      color: white;
      border: none;
      padding: 15px 30px;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.3s;
    }
    .btn-send:hover {
      background: #152d4a;
    }
    .btn-send:disabled {
      background: #ccc;
      cursor: not-allowed;
    }
    .message-result {
      padding: 15px;
      border-radius: 8px;
      margin-top: 15px;
      display: none;
    }
    .message-result.success {
      background: #d1fae5;
      color: #065f46;
      border: 1px solid #34d399;
    }
    .message-result.error {
      background: #fee2e2;
      color: #991b1b;
      border: 1px solid #f87171;
    }
    
    .conversation-list { display: flex; flex-direction: column; gap: 15px; }
    .conversation-item {
      padding: 20px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.3s;
      position: relative;
    }
    .conversation-item:hover {
      border-color: #1e3a5f;
      background: #f0f4f8;
      transform: translateX(5px);
    }
    .conversation-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .conversation-info {
      flex: 1;
    }
    .btn-delete {
      background: #ef4444;
      color: white;
      border: none;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      font-size: 1.2rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s;
      flex-shrink: 0;
      margin-left: 15px;
    }
    .btn-delete:hover {
      background: #dc2626;
      transform: scale(1.1);
    }
    .conversation-item .phone { font-weight: bold; font-size: 1.1rem; color: #333; }
    .conversation-item .name { color: #1e3a5f; font-size: 0.9rem; margin-left: 10px; }
    .conversation-item .info { color: #666; font-size: 0.85rem; margin-top: 8px; }
    .conversation-item .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 0.75rem;
      margin-left: 10px;
      font-weight: 600;
    }
    .badge-active { background: #4ade80; color: white; }
    .badge-converted { background: #1e3a5f; color: white; }
    .badge-stopped { background: #ef4444; color: white; }
    
    .messages-container {
      display: none;
      margin-top: 20px;
      padding: 20px;
      background: #f0f4f8;
      border-radius: 8px;
      border: 2px solid #1e3a5f;
    }
    .messages-title {
      font-weight: bold;
      color: #1e3a5f;
      margin-bottom: 15px;
      font-size: 1.1rem;
    }
    .message {
      padding: 15px;
      margin-bottom: 10px;
      border-radius: 8px;
      max-width: 80%;
    }
    .message.user {
      background: #d6e4f0;
      margin-left: auto;
      text-align: right;
    }
    .message.assistant {
      background: #fff;
      border: 1px solid #e0e0e0;
    }
    .message .role { 
      font-weight: bold; 
      font-size: 0.8rem; 
      margin-bottom: 5px;
      text-transform: uppercase;
    }
    .message.user .role { color: #1e3a5f; }
    .message.assistant .role { color: #764ba2; }
    .message .content { color: #333; line-height: 1.5; white-space: pre-wrap; }
    .message .time { font-size: 0.75rem; color: #666; margin-top: 5px; }
    
    .reply-form {
      margin-top: 20px;
      padding: 20px;
      background: white;
      border-radius: 8px;
      border: 2px solid #1e3a5f;
    }
    .reply-form h4 {
      color: #1e3a5f;
      margin-bottom: 15px;
      font-size: 1rem;
    }
    .reply-input-group {
      display: flex;
      gap: 10px;
    }
    .reply-input {
      flex: 1;
      padding: 12px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 0.95rem;
      font-family: inherit;
    }
    .reply-input:focus {
      outline: none;
      border-color: #1e3a5f;
    }
    .btn-reply {
      background: #1e3a5f;
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 8px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.3s;
      white-space: nowrap;
    }
    .btn-reply:hover {
      background: #152d4a;
    }
    .btn-reply:disabled {
      background: #ccc;
      cursor: not-allowed;
    }
    .reply-status {
      margin-top: 10px;
      padding: 10px;
      border-radius: 6px;
      font-size: 0.9rem;
      display: none;
    }
    .reply-status.success {
      background: #d1fae5;
      color: #065f46;
    }
    .reply-status.error {
      background: #fee2e2;
      color: #991b1b;
    }
    
    .appointment-card {
      padding: 15px;
      background: #f0fdf4;
      border-left: 4px solid #4ade80;
      border-radius: 8px;
      margin-bottom: 15px;
      cursor: pointer;
      transition: all 0.3s;
    }
    .appointment-card:hover {
      background: #dcfce7;
      transform: translateX(5px);
    }
    .callback-card {
      padding: 15px;
      background: #fef3c7;
      border-left: 4px solid #fbbf24;
      border-radius: 8px;
      margin-bottom: 15px;
      cursor: pointer;
      transition: all 0.3s;
    }
    .callback-card:hover {
      background: #fde68a;
      transform: translateX(5px);
    }
    .card-title { font-weight: bold; color: #333; font-size: 1.1rem; flex: 1; }
    .card-preview { font-size: 0.85rem; color: #666; margin-top: 8px; }
    .card-header { display: flex; justify-content: space-between; align-items: center; }
    .expand-icon { font-size: 1.5rem; color: #c41e3a; transition: transform 0.3s; user-select: none; }
    .expand-icon.expanded { transform: rotate(180deg); }
    .card-details { display: none; margin-top: 15px; padding-top: 15px; border-top: 2px solid rgba(0,0,0,0.1); }
    .card-details.visible { display: block; }
    .detail-row { display: flex; margin-bottom: 8px; font-size: 0.9rem; }
    .detail-label { font-weight: 600; color: #333; min-width: 140px; }
    .detail-value { color: #666; }
    .card-info { font-size: 0.9rem; color: #666; margin-top: 4px; }
    
    .loading { text-align: center; color: #666; padding: 40px; }
    .empty-state { text-align: center; color: #999; padding: 40px; font-style: italic; }

    .search-box {
      margin-bottom: 20px;
      padding: 12px;
      width: 100%;
      max-width: 500px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 1rem;
      font-family: inherit;
    }
    .search-box:focus {
      outline: none;
      border-color: #1e3a5f;
    }
    .search-box::placeholder {
      color: #999;
    }
    
    @media (max-width: 768px) {
      h1 { font-size: 1.8rem; }
      .stats { grid-template-columns: repeat(2, 1fr); }
      .section { padding: 20px; }
      .reply-input-group {
        flex-direction: column;
      }
    }
  </style>
</head>
<body>

      <!-- EXPORT SECTION -->
      <div style="max-width: 1200px; margin: 20px auto; background: white; padding: 30px; border-radius: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.1);">
        <h2 style="margin: 0 0 10px 0; color: #2d3748;">📊 Export Data to CSV</h2>
        <p style="color: #718096; margin-bottom: 25px;">Download data for Excel/Google Sheets</p>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
          <a href="/api/export/appointments" download style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 18px; border-radius: 10px; text-decoration: none; font-weight: bold; text-align: center; box-shadow: 0 4px 6px rgba(16,185,129,0.3); transition: all 0.3s;" onmouseover="this.style.transform='translateY(-3px)'" onmouseout="this.style.transform='translateY(0)'">📅 Appointments</a>
          <a href="/api/export/callbacks" download style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; padding: 18px; border-radius: 10px; text-decoration: none; font-weight: bold; text-align: center; box-shadow: 0 4px 6px rgba(245,158,11,0.3); transition: all 0.3s;" onmouseover="this.style.transform='translateY(-3px)'" onmouseout="this.style.transform='translateY(0)'">📞 Callbacks</a>
          <a href="/api/export/conversations" download style="background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: white; padding: 18px; border-radius: 10px; text-decoration: none; font-weight: bold; text-align: center; box-shadow: 0 4px 6px rgba(59,130,246,0.3); transition: all 0.3s;" onmouseover="this.style.transform='translateY(-3px)'" onmouseout="this.style.transform='translateY(0)'">💬 Conversations</a>
          <a href="/api/export/analytics" download style="background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: white; padding: 18px; border-radius: 10px; text-decoration: none; font-weight: bold; text-align: center; box-shadow: 0 4px 6px rgba(139,92,246,0.3); transition: all 0.3s;" onmouseover="this.style.transform='translateY(-3px)'" onmouseout="this.style.transform='translateY(0)'">📈 Analytics</a>
        </div>
      </div>

  <div class="container">
    <div style="display: flex; align-items: center; justify-content: center; margin-bottom: 30px;"><img src="data:image/jpeg;base64,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" alt="First Financial Canada" style="height: 80px; margin-right: 20px;"><h1 style="margin: 0; color: white;">First Financial SMS Dashboard</h1></div>
    
    <div class="stats" id="stats">
      <div class="stat-card">
        <h3>Total Customers</h3>
        <div class="number" id="totalCustomers">-</div>
      </div>
      <div class="stat-card">
        <h3>Conversations</h3>
        <div class="number" id="totalConversations">-</div>
      </div>
      <div class="stat-card">
        <h3>Messages</h3>
        <div class="number" id="totalMessages">-</div>
      </div>
      <div class="stat-card">
        <h3>Appointments</h3>
        <div class="number" id="totalAppointments">-</div>
      </div>
      <div class="stat-card">
        <h3>Callbacks</h3>
        <div class="number" id="totalCallbacks">-</div>
      </div>
    </div>
    
    <div class="section">
      <h2>📊 Analytics & Insights</h2>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 20px;">
        <div style="background: linear-gradient(135deg, #1e3a5f 0%, #2c4e6f 100%); padding: 25px; border-radius: 12px; color: white; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
          <div style="font-size: 0.9rem; opacity: 0.9; margin-bottom: 8px;">Conversion Rate</div>
          <div style="font-size: 2.5rem; font-weight: bold;" id="conversionRate">-</div>
          <div style="font-size: 0.8rem; opacity: 0.8; margin-top: 5px;" id="conversionDetail">-</div>
        </div>
        <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 25px; border-radius: 12px; color: white; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
          <div style="font-size: 0.9rem; opacity: 0.9; margin-bottom: 8px;">Response Rate</div>
          <div style="font-size: 2.5rem; font-weight: bold;" id="responseRate">-</div>
          <div style="font-size: 0.8rem; opacity: 0.8; margin-top: 5px;" id="responseDetail">-</div>
        </div>
        <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 25px; border-radius: 12px; color: white; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
          <div style="font-size: 0.9rem; opacity: 0.9; margin-bottom: 8px;">Avg Messages/Conv</div>
          <div style="font-size: 2.5rem; font-weight: bold;" id="avgMessages">-</div>
          <div style="font-size: 0.8rem; opacity: 0.8; margin-top: 5px;">per conversation</div>
        </div>
        <div style="background: linear-gradient(135deg, #c41e3a 0%, #a01729 100%); padding: 25px; border-radius: 12px; color: white; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
          <div style="font-size: 0.9rem; opacity: 0.9; margin-bottom: 8px;">This Week</div>
          <div style="font-size: 2.5rem; font-weight: bold;" id="weekConversations">-</div>
          <div style="font-size: 0.8rem; opacity: 0.8; margin-top: 5px;" id="weekDetail">-</div>
        </div>
      </div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px;">
        <div style="background: #f0f4f8; padding: 20px; border-radius: 12px; border-left: 4px solid #1e3a5f;">
          <h3 style="margin: 0 0 15px 0; color: #1e3a5f; font-size: 1rem;">Top Vehicle Types</h3>
          <div id="topVehicles" style="font-size: 0.9rem; color: #666;"><div style="padding: 8px 0;">Loading...</div></div>
        </div>
        <div style="background: #f0f4f8; padding: 20px; border-radius: 12px; border-left: 4px solid #10b981;">
          <h3 style="margin: 0 0 15px 0; color: #10b981; font-size: 1rem;">Budget Distribution</h3>
          <div id="budgetDist" style="font-size: 0.9rem; color: #666;"><div style="padding: 8px 0;">Loading...</div></div>
        </div>
      </div>
    </div>

        <div class="section">
      <h2>📱 Launch SMS - Send SMS Campaign</h2>
      <form class="launch-form" id="launchForm" onsubmit="sendSMS(event)">
        <div class="form-group">
          <label for="phoneNumber">Phone Number</label>
          <input 
            type="tel" 
            id="phoneNumber" 
            name="phoneNumber" 
            placeholder="+1 (403) 555-0100"
            required
          >
        </div>
        <div class="form-group">
          <label for="message">Message</label>
          <textarea 
            id="message" 
            name="message"
          >Hi! 👋 I'm Jerry from the dealership. I wanted to reach out and see if you're interested in finding your perfect vehicle. What type of car are you looking for? (Reply STOP to opt out)</textarea>
        </div>
        <button type="submit" class="btn-send" id="sendBtn">
          🚀 Send Message
        </button>
        <div id="messageResult" class="message-result"></div>
      </form>
    </div>
    
    <div class="section">
      <h2>📱 Recent Conversations (Click to View Messages)</h2>
      <input 
        type="text" 
        id="searchBox" 
        class="search-box" 
        placeholder="🔍 Search by phone number or name..."
        onkeyup="filterConversations()"
      >
      <div class="conversation-list" id="conversationList">
        <div class="loading">Loading conversations...</div>
      </div>
    </div>
    
    <div class="section">
      <h2>🚗 Recent Appointments</h2>
      <div id="appointmentsList">
        <div class="loading">Loading appointments...</div>
      </div>
    </div>
    
    <div class="section">
      <h2>📞 Recent Callbacks</h2>
      <div id="callbacksList">
        <div class="loading">Loading callbacks...</div>
      </div>
    </div>
  </div>
  
  <script>
    document.getElementById('phoneNumber').addEventListener('input', function(e) {
      let value = e.target.value.replace(/\\D/g, '');
      
      if (value.length > 0 && !value.startsWith('1')) {
        value = '1' + value;
      }
      
      let formatted = '';
      if (value.length > 0) {
        formatted = '+' + value.substring(0, 1);
        if (value.length > 1) {
          formatted += ' (' + value.substring(1, 4);
        }
        if (value.length > 4) {
          formatted += ') ' + value.substring(4, 7);
        }
        if (value.length > 7) {
          formatted += '-' + value.substring(7, 11);
        }
      }
      
      e.target.value = formatted;
    });
    
    async function sendSMS(event) {
      event.preventDefault();
      
      const phoneNumber = document.getElementById('phoneNumber').value.replace(/\\D/g, '');
      const fullPhone = phoneNumber.startsWith('1') ? '+' + phoneNumber : '+1' + phoneNumber;
      const customMessage = document.getElementById('message').value;
      const sendBtn = document.getElementById('sendBtn');
      const resultDiv = document.getElementById('messageResult');
      
      sendBtn.disabled = true;
      sendBtn.textContent = '⏳ Sending...';
      resultDiv.style.display = 'none';
      
      try {
        const response = await fetch('/api/start-sms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            phone: fullPhone,
            message: customMessage
          })
        });
        
        const data = await response.json();
        
        if (data.success) {
          resultDiv.className = 'message-result success';
          resultDiv.textContent = '✅ SMS sent successfully to ' + fullPhone;
          resultDiv.style.display = 'block';
          document.getElementById('phoneNumber').value = '';
          
          setTimeout(loadDashboard, 2000);
        } else {
          throw new Error(data.error || 'Failed to send SMS');
        }
      } catch (error) {
        resultDiv.className = 'message-result error';
        resultDiv.textContent = '❌ Error: ' + error.message;
        resultDiv.style.display = 'block';
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = '🚀 Send Message';
      }
    }
    
    async function sendManualReply(phone, inputId, btnId, statusId) {
      const input = document.getElementById(inputId);
      const btn = document.getElementById(btnId);
      const status = document.getElementById(statusId);
      const message = input.value.trim();
      
      if (!message) {
        return;
      }
      
      btn.disabled = true;
      btn.textContent = 'Sending...';
      status.style.display = 'none';
      
      try {
        const response = await fetch('/api/manual-reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, message })
        });
        
        const data = await response.json();
        
        if (data.success) {
          status.className = 'reply-status success';
          status.textContent = '✅ Reply sent!';
          status.style.display = 'block';
          input.value = '';
          
          setTimeout(() => {
            viewConversation(phone, null);
            status.style.display = 'none';
          }, 2000);
        } else {
          throw new Error(data.error || 'Failed to send reply');
        }
      } catch (error) {
        status.className = 'reply-status error';
        status.textContent = '❌ ' + error.message;
        status.style.display = 'block';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Send Reply';
      }
    }
    
    async function deleteConversation(phone, event) {
      event.stopPropagation();
      
      if (!confirm('Are you sure you want to delete this conversation? This cannot be undone.')) {
        return;
      }
      
      try {
        const response = await fetch('/api/conversation/' + encodeURIComponent(phone), {
          method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
          loadDashboard();
        } else {
          alert('Error deleting conversation: ' + (data.error || 'Unknown error'));
        }
      } catch (error) {
        alert('Error deleting conversation: ' + error.message);
      }
    }
    
    
    function filterConversations() {
      const searchBox = document.getElementById('searchBox');
      const searchTerm = searchBox.value.toLowerCase().replace(/[^0-9a-z]/g, '');
      const conversationItems = document.querySelectorAll('.conversation-item');

      conversationItems.forEach(item => {
        const phoneElement = item.querySelector('.phone');
        const nameElement = item.querySelector('.name');

        if (phoneElement && nameElement) {
          const phone = phoneElement.textContent.toLowerCase().replace(/[^0-9]/g, '');
          const name = nameElement.textContent.toLowerCase().replace(/[^a-z]/g, '');

          if (phone.includes(searchTerm) || name.includes(searchTerm)) {
            item.style.display = '';
          } else {
            item.style.display = 'none';
          }
        }
      });
    }

    function toggleAppointment(id) {
      const details = document.getElementById('apt-details-' + id);
      const icon = document.getElementById('apt-icon-' + id);
      if (details && icon) {
        if (details.classList.contains('visible')) {
          details.classList.remove('visible');
          icon.classList.remove('expanded');
        } else {
          details.classList.add('visible');
          icon.classList.add('expanded');
        }
      }
    }

    function toggleCallback(id) {
      const details = document.getElementById('cb-details-' + id);
      const icon = document.getElementById('cb-icon-' + id);
      if (details && icon) {
        if (details.classList.contains('visible')) {
          details.classList.remove('visible');
          icon.classList.remove('expanded');
        } else {
          details.classList.add('visible');
          icon.classList.add('expanded');
        }
      }
    }

    async function loadDashboard() {
      try {
        const statsData = await fetch('/api/dashboard').then(r => r.json());

        // Load Analytics
        try {
          const analyticsData = await fetch('/api/analytics').then(r => r.json());
          if (analyticsData && !analyticsData.error) {
            document.getElementById('conversionRate').textContent = analyticsData.conversionRate + '%';
            document.getElementById('conversionDetail').textContent = analyticsData.totalConverted + ' of ' + analyticsData.totalConversations + ' conversations';
            document.getElementById('responseRate').textContent = analyticsData.responseRate + '%';
            document.getElementById('responseDetail').textContent = analyticsData.totalResponded + ' customers responded';
            document.getElementById('avgMessages').textContent = analyticsData.avgMessages;
            document.getElementById('weekConversations').textContent = analyticsData.weekConversations;
            document.getElementById('weekDetail').textContent = analyticsData.weekConverted + ' converted this week';

            const topVeh = analyticsData.topVehicles.length > 0 
              ? analyticsData.topVehicles.map((v, i) => '<div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #ddd;"><span>' + (i+1) + '. ' + v.vehicle_type + '</span><span style="font-weight: bold; color: #1e3a5f;">' + v.count + '</span></div>').join('')
              : '<div style="padding: 8px 0; color: #999;">No data yet</div>';
            document.getElementById('topVehicles').innerHTML = topVeh;

            const budg = analyticsData.budgetDist.length > 0 
              ? analyticsData.budgetDist.map(b => '<div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #ddd;"><span>' + b.budget + '</span><span style="font-weight: bold; color: #10b981;">' + b.count + '</span></div>').join('')
              : '<div style="padding: 8px 0; color: #999;">No data yet</div>';
            document.getElementById('budgetDist').innerHTML = budg;
          }
        } catch (e) {
          console.error('Analytics load error:', e);
        }

        document.getElementById('totalCustomers').textContent = statsData.stats.totalCustomers;
        document.getElementById('totalConversations').textContent = statsData.stats.totalConversations;
        document.getElementById('totalMessages').textContent = statsData.stats.totalMessages;
        document.getElementById('totalAppointments').textContent = statsData.stats.totalAppointments;
        document.getElementById('totalCallbacks').textContent = statsData.stats.totalCallbacks;
        
        const conversations = await fetch('/api/conversations').then(r => r.json());
        const conversationList = document.getElementById('conversationList');
        
        if (conversations.length === 0) {
          conversationList.innerHTML = '<div class="empty-state">No conversations yet. Use "Launch Jerry" above to send your first SMS!</div>';
        } else {
          conversationList.innerHTML = conversations.map(conv => \`
            <div class="conversation-item">
              <div class="conversation-header">
                <div class="conversation-info" onclick="viewConversation('\${conv.customer_phone}', this)">
                  <div>
                    <span class="phone">\${conv.customer_phone}</span>
                    <span class="name">\${conv.customer_name || 'Unknown'}</span>
                    <span class="badge badge-\${conv.status}">\${conv.status}</span>
                  </div>
                  <div class="info">
                    \${conv.vehicle_type || 'No vehicle selected'} • 
                    \${conv.budget || 'No budget set'} • 
                    Stage: \${conv.stage} • 
                    \${conv.message_count} messages
                  </div>
                  <div class="info">Started: \${new Date(conv.started_at).toLocaleString()}</div>
                </div>
                <button class="btn-delete" onclick="deleteConversation('\${conv.customer_phone}', event)" title="Delete conversation">×</button>
              </div>
              <div class="messages-container" id="messages-\${conv.customer_phone.replace(/[^0-9]/g, '')}"></div>
            </div>
          \`).join('');
        }
        
        const appointmentsList = document.getElementById('appointmentsList');
        if (statsData.recentAppointments.length === 0) {
          appointmentsList.innerHTML = '<div class="empty-state">No appointments yet.</div>';
        } else {
          appointmentsList.innerHTML = statsData.recentAppointments.map(apt => \`
            <div class="appointment-card" onclick="toggleAppointment(\${apt.id})">
              <div class="card-header">
                <div style="flex: 1;">
                  <div class="card-title">🚗 \${apt.customer_name} - \${apt.vehicle_type}</div>
                  <div class="card-preview">📞 \${apt.customer_phone} • 📅 \${apt.datetime}</div>
                </div>
                <span class="expand-icon" id="apt-icon-\${apt.id}">▼</span>
              </div>
              <div class="card-details" id="apt-details-\${apt.id}">
                <div class="detail-row"><span class="detail-label">Customer Name:</span><span class="detail-value">\${apt.customer_name}</span></div>
                <div class="detail-row"><span class="detail-label">Phone Number:</span><span class="detail-value">\${apt.customer_phone}</span></div>
                <div class="detail-row"><span class="detail-label">Vehicle Type:</span><span class="detail-value">\${apt.vehicle_type}</span></div>
                <div class="detail-row"><span class="detail-label">Budget:</span><span class="detail-value">\${apt.budget}\${apt.budget_amount ? ' ($' + apt.budget_amount.toLocaleString() + ')' : ''}</span></div>
                <div class="detail-row"><span class="detail-label">Appointment Date/Time:</span><span class="detail-value">\${apt.datetime}</span></div>
                <div class="detail-row"><span class="detail-label">Booked On:</span><span class="detail-value">\${new Date(apt.created_at).toLocaleString()}</span></div>
              </div>
            </div>
          \`).join('');
        }
        
        const callbacksList = document.getElementById('callbacksList');
        if (statsData.recentCallbacks.length === 0) {
          callbacksList.innerHTML = '<div class="empty-state">No callback requests yet.</div>';
        } else {
          callbacksList.innerHTML = statsData.recentCallbacks.map(cb => \`
            <div class="callback-card" onclick="toggleCallback(\${cb.id})">
              <div class="card-header">
                <div style="flex: 1;">
                  <div class="card-title">📞 \${cb.customer_name} - \${cb.vehicle_type}</div>
                  <div class="card-preview">📞 \${cb.customer_phone} • ⏰ \${cb.datetime}</div>
                </div>
                <span class="expand-icon" id="cb-icon-\${cb.id}">▼</span>
              </div>
              <div class="card-details" id="cb-details-\${cb.id}">
                <div class="detail-row"><span class="detail-label">Customer Name:</span><span class="detail-value">\${cb.customer_name}</span></div>
                <div class="detail-row"><span class="detail-label">Phone Number:</span><span class="detail-value">\${cb.customer_phone}</span></div>
                <div class="detail-row"><span class="detail-label">Vehicle Type:</span><span class="detail-value">\${cb.vehicle_type}</span></div>
                <div class="detail-row"><span class="detail-label">Budget:</span><span class="detail-value">\${cb.budget}\${cb.budget_amount ? ' ($' + cb.budget_amount.toLocaleString() + ')' : ''}</span></div>
                <div class="detail-row"><span class="detail-label">Preferred Call Time:</span><span class="detail-value">\${cb.datetime}</span></div>
                <div class="detail-row"><span class="detail-label">Requested On:</span><span class="detail-value">\${new Date(cb.created_at).toLocaleString()}</span></div>
              </div>
            </div>
          \`).join('');
        }
      } catch (error) {
        console.error('Error loading dashboard:', error);
      }
    }
    
    async function viewConversation(phone, element) {
      const cleanPhone = phone.replace(/[^0-9]/g, '');
      const messagesContainer = document.getElementById('messages-' + cleanPhone);
      
      if (messagesContainer.style.display === 'block') {
        messagesContainer.style.display = 'none';
        return;
      }
      
      messagesContainer.innerHTML = '<div class="loading">Loading messages...</div>';
      messagesContainer.style.display = 'block';
      
      try {
        const data = await fetch('/api/conversation/' + encodeURIComponent(phone)).then(r => r.json());
        
        if (data.error) {
          messagesContainer.innerHTML = '<div class="empty-state">Error loading messages</div>';
          return;
        }
        
        if (data.messages.length === 0) {
          messagesContainer.innerHTML = '<div class="empty-state">No messages yet</div>';
          return;
        }
        
        const replyFormId = 'reply-' + cleanPhone;
        const inputId = 'input-' + cleanPhone;
        const btnId = 'btn-' + cleanPhone;
        const statusId = 'status-' + cleanPhone;
        
        messagesContainer.innerHTML = '<div class="messages-title">💬 Full Conversation Thread</div>' + 
          data.messages.map(msg => \`
            <div class="message \${msg.role}">
              <div class="role">\${msg.role === 'user' ? '👤 Customer' : '🤖 Jerry AI'}</div>
              <div class="content">\${msg.content}</div>
              <div class="time">\${new Date(msg.created_at).toLocaleString()}</div>
            </div>
          \`).join('') +
          \`
          <div class="reply-form" id="\${replyFormId}">
            <h4>💬 Send Manual Reply</h4>
            <div class="reply-input-group">
              <input 
                type="text" 
                class="reply-input" 
                id="\${inputId}" 
                placeholder="Type your message to this customer..."
                onkeypress="if(event.key === 'Enter') { event.preventDefault(); sendManualReply('\${phone}', '\${inputId}', '\${btnId}', '\${statusId}'); }"
              >
              <button 
                class="btn-reply" 
                id="\${btnId}"
                onclick="sendManualReply('\${phone}', '\${inputId}', '\${btnId}', '\${statusId}')"
              >
                Send Reply
              </button>
            </div>
            <div class="reply-status" id="\${statusId}"></div>
          </div>
          \`;
      } catch (error) {
        messagesContainer.innerHTML = '<div class="empty-state">Error loading messages</div>';
      }
    }
    
    loadDashboard();
    setInterval(loadDashboard, 10000);
  </script>
</body>
</html>
  `);
});

// API: Dashboard stats
app.get('/api/dashboard', async (req, res) => {
  const client = await pool.connect();
  try {
    const customers = await client.query('SELECT COUNT(*) as count FROM customers');
    const conversations = await client.query('SELECT COUNT(*) as count FROM conversations');
    const messages = await client.query('SELECT COUNT(*) as count FROM messages');
    const appointments = await client.query('SELECT * FROM appointments ORDER BY created_at DESC LIMIT 25');
    const callbacks = await client.query('SELECT * FROM callbacks ORDER BY created_at DESC LIMIT 25');
    
    res.json({
      stats: {
        totalCustomers: parseInt(customers.rows[0].count),
        totalConversations: parseInt(conversations.rows[0].count),
        totalMessages: parseInt(messages.rows[0].count),
        totalAppointments: appointments.rows.length,
        totalCallbacks: callbacks.rows.length
      },
      recentAppointments: appointments.rows,
      recentCallbacks: callbacks.rows
    });
  } catch (error) {
    res.json({ error: error.message });
  } finally {
    client.release();
  }
});

// API: Get all conversations
app.get('/api/conversations', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT 
        c.id,
        c.customer_phone,
        cu.name as customer_name,
        c.stage,
        c.status,
        c.vehicle_type,
        c.budget,
        c.started_at,
        c.updated_at,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count
      FROM conversations c
      LEFT JOIN customers cu ON c.customer_phone = cu.phone
      ORDER BY c.updated_at DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (error) {
    res.json({ error: error.message });
  } finally {
    client.release();
  }
});

// API: Get conversation history
app.get('/api/conversation/:phone', async (req, res) => {
  const client = await pool.connect();
  try {
    const { phone } = req.params;
    
    const conversation = await client.query(
      'SELECT * FROM conversations WHERE customer_phone = $1 ORDER BY started_at DESC LIMIT 1',
      [phone]
    );
    
    if (conversation.rows.length === 0) {
      return res.json({ error: 'No conversation found' });
    }
    
    const messages = await client.query(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [conversation.rows[0].id]
    );
    
    res.json({
      conversation: conversation.rows[0],
      messages: messages.rows
    });
  } catch (error) {
    res.json({ error: error.message });
  } finally {
    client.release();
  }
});

// API: Delete conversation
app.delete('/api/conversation/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const deleted = await deleteConversation(phone);
    
    if (deleted) {
      res.json({ success: true, message: 'Conversation deleted' });
    } else {
      res.json({ success: false, error: 'Conversation not found' });
    }
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// API: Manual reply (NEW)
app.post('/api/manual-reply', async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
      return res.json({ success: false, error: 'Phone and message required' });
    }
    
    const conversation = await getOrCreateConversation(phone);
    await saveMessage(conversation.id, phone, 'assistant', message);
    await touchConversation(conversation.id);
    await logAnalytics('manual_reply_sent', phone, { message });
    
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;
    const client = twilio(accountSid, authToken);
    
    await client.messages.create({
      body: message,
      from: fromNumber,
      to: phone
    });
    
    console.log('✅ Manual reply sent to:', phone);
    res.json({ success: true, message: 'Reply sent!' });
  } catch (error) {
    console.error('❌ Error sending manual reply:', error);
    res.json({ success: false, error: error.message });
  }
});

// Start SMS campaign
app.post('/api/start-sms', async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    if (!phone) {
      return res.json({ success: false, error: 'Phone number required' });
    }
    
    const hasActive = await hasActiveConversation(phone);
    
    if (hasActive) {
      return res.json({ 
        success: false, 
        error: 'This customer already has an active conversation. Check "Recent Conversations" below to continue their conversation.' 
      });
    }
    
    const messageBody = message || "Hi! 👋 I'm Jerry from the dealership. I wanted to reach out and see if you're interested in finding your perfect vehicle. What type of car are you looking for? (Reply STOP to opt out)";
    
    await getOrCreateCustomer(phone);
    await getOrCreateConversation(phone);
    await logAnalytics('sms_sent', phone, { source: 'manual_campaign', message: messageBody });
    
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;
    const client = twilio(accountSid, authToken);
    
    await client.messages.create({
      body: messageBody,
      from: fromNumber,
      to: phone
    });
    
    console.log('✅ SMS sent to:', phone);
    res.json({ success: true, message: 'SMS sent!' });
  } catch (error) {
    console.error('❌ Error sending SMS:', error);
    res.json({ success: false, error: error.message });
  }
});

// Twilio Webhook
app.post('/api/sms-webhook', async (req, res) => {
  try {
    const { From: phone, Body: message } = req.body;
    
    console.log('📩 Received from:', phone);
    console.log('💬 Message:', message);
    
    // Respond to Twilio IMMEDIATELY (prevents retries/duplicates)
    res.type('text/xml').send('<Response></Response>');
    
    // Now do all the work in background (won't block Twilio)
    (async () => {
      try {
        await getOrCreateCustomer(phone);
        const conversation = await getOrCreateConversation(phone);
        await saveMessage(conversation.id, phone, 'user', message);
        
        try {
          const emailSubject = '🚨 New Message from ' + (conversation.customer_name || formatPhone(phone));
          const emailBody = '<div style="font-family: Arial; max-width: 600px;"><div style="background: linear-gradient(135deg, #1e3a5f 0%, #2c4e6f 100%); padding: 20px; border-radius: 10px 10px 0 0;"><h1 style="color: white; margin: 0;">🚨 New Customer Message</h1></div><div style="background: #f7fafc; padding: 25px; border-radius: 0 0 10px 10px;"><table><tr><td style="padding: 12px; font-weight: bold;">Phone:</td><td style="padding: 12px;">' + formatPhone(phone) + '</td></tr><tr><td style="padding: 12px; font-weight: bold;">Name:</td><td style="padding: 12px;">' + (conversation.customer_name||'Not provided') + '</td></tr><tr><td style="padding: 12px; font-weight: bold;">Message:</td><td style="padding: 12px; font-weight: 600;">' + message + '</td></tr></table></div></div>';
          await sendEmailNotification(emailSubject, emailBody);
        } catch (err) { 
          console.error('Email error:', err); 
        }
        
        await touchConversation(conversation.id);
        await logAnalytics('message_received', phone, { message });
        
        const aiResponse = await getJerryResponse(phone, message, conversation);
        await saveMessage(conversation.id, phone, 'assistant', aiResponse);
        
        // Send SMS
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        const fromNumber = process.env.TWILIO_PHONE_NUMBER;
        const client = twilio(accountSid, authToken);
        
        await client.messages.create({
          body: aiResponse,
          from: fromNumber,
          to: phone
        });
        
        console.log('✅ Jerry replied:', aiResponse);
      } catch (bgError) {
        console.error('❌ Background processing error:', bgError);
      }
    })();
    
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.type('text/xml').send('<Response></Response>');
  }
});


// Jerry AI Logic
async function getJerryResponse(phone, message, conversation) {
  const lowerMsg = message.toLowerCase();
  
  if (lowerMsg === 'stop') {
    await updateConversation(conversation.id, { status: 'stopped' });
    await logAnalytics('conversation_stopped', phone, {});
    return "You've been unsubscribed. Reply START to resume.";
  }
  
  if (lowerMsg.includes('location') || lowerMsg.includes('where') || lowerMsg.includes('address') || 
      lowerMsg.includes('dealership') || lowerMsg.includes('calgary') || lowerMsg.includes('alberta')) {
    return "We're located in Calgary, Alberta, and we deliver vehicles all across Canada! 🇨🇦 If you'd like specific dealership details or directions, I can have a manager call you back shortly. Just let me know!";
  }
  
  if (lowerMsg.includes('detail') || lowerMsg.includes('more info') || lowerMsg.includes('tell me more') ||
      (lowerMsg.includes('manager') && lowerMsg.includes('call'))) {
    return "I'd be happy to have one of our managers reach out to you with all the details! What's the best time to call you? (e.g., Tomorrow at 2pm, This afternoon, Friday morning)";
  }
  
  if (conversation.stage === 'greeting' || !conversation.vehicle_type) {
    
    if (lowerMsg.includes('suv')) {
      await updateConversation(conversation.id, { 
        vehicle_type: 'SUV',
        stage: 'budget'
      });
      return `Great choice! SUVs are very popular. What's your budget range? (e.g., $15k, $25k, $40k, $60k+)`;
    }
    
    if (lowerMsg.includes('truck')) {
      await updateConversation(conversation.id, { 
        vehicle_type: 'Truck',
        stage: 'budget'
      });
      return `Awesome! Trucks are great. What's your budget range? (e.g., $15k, $25k, $40k, $60k+)`;
    }
    
    if (lowerMsg.includes('sedan')) {
      await updateConversation(conversation.id, { 
        vehicle_type: 'Sedan',
        stage: 'budget'
      });
      return `Perfect! Sedans are reliable. What's your budget range? (e.g., $15k, $25k, $40k, $60k+)`;
    }
    
    if (lowerMsg.includes('car') || lowerMsg.includes('vehicle') || 
        lowerMsg.includes('yes') || lowerMsg.includes('interested') ||
        lowerMsg.includes('want') || lowerMsg.includes('looking')) {
      await updateConversation(conversation.id, { 
        vehicle_type: 'Vehicle',
        stage: 'budget'
      });
      return `Great! What's your budget range? (e.g., $15k, $25k, $40k, $60k+)`;
    }
    
    return "What type of vehicle interests you? We have SUVs, Trucks, Sedans, Coupes, and more!";
  }
  
  if (conversation.stage === 'budget' && !conversation.budget) {
    const numbers = message.match(/\d+/g);
    let budgetAmount = 0;
    
    if (numbers && numbers.length > 0) {
      budgetAmount = parseInt(numbers[0]);
      
      if (lowerMsg.includes('k') && budgetAmount < 1000) {
        budgetAmount = budgetAmount * 1000;
      }
      
      if (message.includes(',')) {
        const fullNumber = message.replace(/,/g, '');
        const extracted = fullNumber.match(/\d+/);
        if (extracted) {
          budgetAmount = parseInt(extracted[0]);
        }
      }
    }
    
    if (budgetAmount > 0) {
      let budgetRange = '';
      if (budgetAmount < 30000) {
        budgetRange = 'Under $30k';
      } else if (budgetAmount >= 30000 && budgetAmount <= 50000) {
        budgetRange = '$30k-$50k';
      } else {
        budgetRange = '$50k+';
      }
      
      await updateConversation(conversation.id, { 
        budget: budgetRange,
        budget_amount: budgetAmount,
        stage: 'appointment'
      });
      
      return `Perfect! I have some great ${conversation.vehicle_type}s around $${(budgetAmount/1000).toFixed(0)}k. Would you like to:\n1️⃣ Book a test drive\n2️⃣ Schedule a call back\nJust reply 1 or 2!`;
    }
    
    if (lowerMsg.includes('cheap') || lowerMsg.includes('low') || lowerMsg.includes('budget')) {
      await updateConversation(conversation.id, { 
        budget: 'Under $30k',
        stage: 'appointment'
      });
      return `Got it! I have great budget-friendly options. Would you like to:\n1️⃣ Book a test drive\n2️⃣ Schedule a call back\nReply 1 or 2!`;
    }
    
    if (lowerMsg.includes('high') || lowerMsg.includes('premium') || lowerMsg.includes('luxury')) {
      await updateConversation(conversation.id, { 
        budget: '$50k+',
        stage: 'appointment'
      });
      return `Excellent! I have some premium options. Would you like to:\n1️⃣ Book a test drive\n2️⃣ Schedule a call back\nReply 1 or 2!`;
    }
    
    return "What's your budget? Just give me a number like $15k, $20k, $40k, etc.";
  }
  
  if (conversation.stage === 'appointment' && !conversation.intent) {
    if (lowerMsg.includes('1') || lowerMsg.includes('test') || lowerMsg.includes('drive') || 
        lowerMsg.includes('appointment') || lowerMsg.includes('visit')) {
      await updateConversation(conversation.id, { 
        intent: 'test_drive',
        stage: 'name'
      });
      return "Awesome! What's your name?";
    }
    
    if (lowerMsg.includes('2') || lowerMsg.includes('call') || lowerMsg.includes('phone') || 
        lowerMsg.includes('talk')) {
      await updateConversation(conversation.id, { 
        intent: 'callback',
        stage: 'name'
      });
      return "Great! What's your name?";
    }
    
    return "Would you like to:\n1️⃣ Book a test drive\n2️⃣ Schedule a call back\nJust reply 1 or 2!";
  }
  
  if (conversation.stage === 'name' && !conversation.customer_name) {
    let name = message.trim();
    
    if (lowerMsg.includes('my name is')) {
      name = message.split(/my name is/i)[1].trim();
    } else if (lowerMsg.includes("i'm")) {
      name = message.split(/i'm/i)[1].trim();
    } else if (lowerMsg.includes("i am")) {
      name = message.split(/i am/i)[1].trim();
    }
    
    name = name.charAt(0).toUpperCase() + name.slice(1);
    
    await updateConversation(conversation.id, { 
      customer_name: name,
      stage: 'datetime'
    });
    
    await pool.query(
      'UPDATE customers SET name = $1, last_contact = CURRENT_TIMESTAMP WHERE phone = $2',
      [name, phone]
    );
    
    if (conversation.intent === 'test_drive') {
      return `Nice to meet you, ${name}! When works best for your test drive? (e.g., Tomorrow afternoon, Saturday morning, Next week)`;
    } else {
      return `Nice to meet you, ${name}! When's the best time to call you? (e.g., Tomorrow at 2pm, Friday morning, This evening)`;
    }
  }
  
  if (conversation.stage === 'datetime' && !conversation.datetime) {
    await updateConversation(conversation.id, { 
      datetime: message,
      stage: 'confirmed',
      status: 'converted'
    });
    
    const appointmentData = {
      phone: phone,
      name: conversation.customer_name,
      vehicleType: conversation.vehicle_type,
      budget: conversation.budget,
      budgetAmount: conversation.budget_amount,
      datetime: message
    };
    
    if (conversation.intent === 'test_drive') {
      await saveAppointment(appointmentData);
      try {
        await sendEmailNotification('📅 Test Drive: ' + conversation.customer_name, '<div style="font-family: Arial;"><h1 style="color: #10b981;">📅 New Appointment!</h1><p><strong>Customer:</strong> ' + conversation.customer_name + '</p><p><strong>Phone:</strong> ' + formatPhone(phone) + '</p><p><strong>Date/Time:</strong> ' + message + '</p></div>');
      } catch (e) { }
      await logAnalytics('appointment_booked', phone, appointmentData);
      return `✅ Perfect ${conversation.customer_name}! I've booked your test drive for ${message}.\n\n📍 We're in Calgary, Alberta and we deliver all across Canada!\n📧 Confirmation sent!\n\nLooking forward to seeing you! Reply STOP to opt out.`;
    } else {
      await saveCallback(appointmentData);
      try {
        await sendEmailNotification('📞 Callback: ' + conversation.customer_name, '<div style="font-family: Arial;"><h1 style="color: #f59e0b;">📞 Callback Requested!</h1><p><strong>Customer:</strong> ' + conversation.customer_name + '</p><p><strong>Phone:</strong> ' + formatPhone(phone) + '</p><p><strong>Time:</strong> ' + message + '</p></div>');
      } catch (e) { }
      await logAnalytics('callback_requested', phone, appointmentData);
      return `✅ Got it ${conversation.customer_name}! One of our managers will call you ${message} with all the details.\n\nWe're excited to help you find your perfect ${conversation.vehicle_type}!\n\nTalk soon! Reply STOP to opt out.`;
    }
  }
  
  if (conversation.stage === 'confirmed') {
    return `Thanks ${conversation.customer_name}! We're all set for ${conversation.datetime}. If you need anything or want to reschedule, just let me know! We're located in Calgary, AB and deliver across Canada.`;
  }
  
  return "Thanks for your message! To help you better, let me know:\n• What type of vehicle? (SUV, Sedan, Truck)\n• Your budget? (e.g., $20k)\n• Test drive or callback?";
}


// ===== TEST & EXPORT ENDPOINTS =====
app.get('/test-email', async (req, res) => {
  try {
    const result = await sendEmailNotification('🧪 Test Email', '<h1>Email Working!</h1><p>Test: ' + new Date().toLocaleString() + '</p>');
    res.json({ success: result, message: result ? '✅ Email sent!' : '❌ Not configured' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/export/appointments', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM appointments ORDER BY created_at DESC');
    const rows = [['ID', 'Phone', 'Name', 'Vehicle', 'Budget', 'Amount', 'DateTime', 'Created'].join(',')];
    result.rows.forEach(r => rows.push([r.id, '"' + r.customer_phone + '"', '"' + (r.customer_name||'') + '"', '"' + (r.vehicle_type||'') + '"', '"' + (r.budget||'') + '"', r.budget_amount||'', '"' + (r.datetime||'') + '"', '"' + r.created_at + '"'].join(',')));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="appointments_' + new Date().toISOString().split('T')[0] + '.csv"');
    res.send(rows.join('\n'));
    console.log('📊 Exported', result.rows.length, 'appointments');
  } catch (e) {
    console.error('❌ Export error:', e);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="appointments_error.csv"');
    res.send('Error,Message\n"Export Failed","' + e.message + '"');
  } finally {
    client.release();
  }
});

app.get('/api/export/callbacks', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM callbacks ORDER BY created_at DESC');
    const rows = [['ID', 'Phone', 'Name', 'Vehicle', 'Budget', 'Amount', 'DateTime', 'Created'].join(',')];
    result.rows.forEach(r => rows.push([r.id, '"' + r.customer_phone + '"', '"' + (r.customer_name||'') + '"', '"' + (r.vehicle_type||'') + '"', '"' + (r.budget||'') + '"', r.budget_amount||'', '"' + (r.datetime||'') + '"', '"' + r.created_at + '"'].join(',')));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="callbacks_' + new Date().toISOString().split('T')[0] + '.csv"');
    res.send(rows.join('\n'));
    console.log('📊 Exported', result.rows.length, 'callbacks');
  } catch (e) {
    console.error('❌ Export error:', e);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="callbacks_error.csv"');
    res.send('Error,Message\n"Export Failed","' + e.message + '"');
  } finally {
    client.release();
  }
});

app.get('/api/export/conversations', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM conversations ORDER BY started_at DESC');
    const rows = [['ID', 'Phone', 'Status', 'Name', 'Vehicle', 'Budget', 'Started', 'Updated'].join(',')];
    result.rows.forEach(r => rows.push([r.id, '"' + r.customer_phone + '"', '"' + r.status + '"', '"' + (r.customer_name||'') + '"', '"' + (r.vehicle_type||'') + '"', '"' + (r.budget||'') + '"', '"' + r.started_at + '"', '"' + r.updated_at + '"'].join(',')));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="conversations_' + new Date().toISOString().split('T')[0] + '.csv"');
    res.send(rows.join('\n'));
    console.log('📊 Exported', result.rows.length, 'conversations');
  } catch (e) {
    console.error('❌ Export error:', e);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="conversations_error.csv"');
    res.send('Error,Message\n"Export Failed","' + e.message + '"');
  } finally {
    client.release();
  }
});

app.get('/api/export/analytics', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM analytics ORDER BY timestamp DESC');
    const rows = [['ID', 'Event', 'Phone', 'Data', 'Timestamp'].join(',')];
    result.rows.forEach(r => rows.push([r.id, '"' + r.event_type + '"', '"' + (r.customer_phone||'') + '"', '"' + JSON.stringify(r.data).replace(/"/g, '""') + '"', '"' + r.timestamp + '"'].join(',')));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="analytics_' + new Date().toISOString().split('T')[0] + '.csv"');
    res.send(rows.join('\n'));
    console.log('📊 Exported', result.rows.length, 'analytics events');
  } catch (e) {
    console.error('❌ Export error:', e);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="analytics_error.csv"');
    res.send('Error,Message\n"Export Failed","' + e.message + '"');
  } finally {
    client.release();
  }
});

// API: Analytics Dashboard Data
app.get('/api/analytics', async (req, res) => {
  const client = await pool.connect();
  try {
    const totalConvs = await client.query('SELECT COUNT(*) as count FROM conversations');
    const totalConversations = parseInt(totalConvs.rows[0].count);

    const converted = await client.query("SELECT COUNT(*) as count FROM conversations WHERE status = 'converted'");
    const totalConverted = parseInt(converted.rows[0].count);

    const responded = await client.query("SELECT COUNT(DISTINCT conversation_id) as count FROM messages WHERE role = 'user'");
    const totalResponded = parseInt(responded.rows[0].count);

    const avgMsgs = await client.query("SELECT COALESCE(AVG(msg_count), 0)::numeric(10,1) as avg FROM (SELECT conversation_id, COUNT(*) as msg_count FROM messages GROUP BY conversation_id) as counts");
    const avgMessages = parseFloat(avgMsgs.rows[0].avg || 0);

    const weekConvs = await client.query("SELECT COUNT(*) as count FROM conversations WHERE started_at >= NOW() - INTERVAL '7 days'");
    const weekConversations = parseInt(weekConvs.rows[0].count);

    const weekConverted = await client.query("SELECT COUNT(*) as count FROM conversations WHERE status = 'converted' AND started_at >= NOW() - INTERVAL '7 days'");
    const weekConvertedCount = parseInt(weekConverted.rows[0].count);

    const topVehicles = await client.query("SELECT vehicle_type, COUNT(*) as count FROM conversations WHERE vehicle_type IS NOT NULL AND vehicle_type != '' GROUP BY vehicle_type ORDER BY count DESC LIMIT 5");

    const budgets = await client.query("SELECT budget, COUNT(*) as count FROM conversations WHERE budget IS NOT NULL AND budget != '' GROUP BY budget ORDER BY count DESC");

    res.json({
      conversionRate: totalConversations > 0 ? ((totalConverted / totalConversations) * 100).toFixed(1) : '0.0',
      totalConverted,
      totalConversations,
      responseRate: totalConversations > 0 ? ((totalResponded / totalConversations) * 100).toFixed(1) : '0.0',
      totalResponded,
      avgMessages: avgMessages.toFixed(1),
      weekConversations,
      weekConverted: weekConvertedCount,
      topVehicles: topVehicles.rows,
      budgetDist: budgets.rows
    });
  } catch (error) {
    console.error('❌ Analytics error:', error);
    res.json({ error: error.message });
  } finally {
    client.release();
  }
});

app.listen(PORT, HOST, () => {
  console.log(`✅ Jerry AI Backend - Database Edition - Port ${PORT}`);
});
