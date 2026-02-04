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
  ssl: { rejectUnauthorized: false }
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
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// ===== TWILIO CONFIGURATION =====
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const TWILIO_FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;

async function sendEmailNotification(subject, htmlContent) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    console.log('⚠️ Email not configured');
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
      manualReply: 'POST /api/manual-reply',
      testEmail: '/test-email',
      exportAppointments: '/api/export/appointments',
      exportCallbacks: '/api/export/callbacks',
      exportConversations: '/api/export/conversations',
      exportAnalytics: '/api/export/analytics'
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
    .stat-card h3 {
      color: #1e3a5f;
      font-size: 0.9rem;
      margin-bottom: 10px;
      text-transform: uppercase;
    }
    .stat-card .number {
      font-size: 2.5rem;
      font-weight: bold;
      color: #333;
    }
    
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
    
    .launch-form { display: grid; gap: 15px; max-width: 600px; }
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
    .btn-send:hover { background: #152d4a; }
    .btn-send:disabled { background: #ccc; cursor: not-allowed; }
    
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
    
    .conversation-list {
      display: flex;
      flex-direction: column;
      gap: 15px;
    }
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
    .conversation-info { flex: 1; }
    
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
    
    .conversation-item .phone {
      font-weight: bold;
      font-size: 1.1rem;
      color: #333;
    }
    .conversation-item .name {
      color: #1e3a5f;
      font-size: 0.9rem;
      margin-left: 10px;
    }
    .conversation-item .info {
      color: #666;
      font-size: 0.85rem;
      margin-top: 8px;
    }
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
    .message .content {
      color: #333;
      line-height: 1.5;
      white-space: pre-wrap;
    }
    .message .time {
      font-size: 0.75rem;
      color: #666;
      margin-top: 5px;
    }
    
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
    .btn-reply:hover { background: #152d4a; }
    .btn-reply:disabled { background: #ccc; cursor: not-allowed; }
    
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
    
    .card-title {
      font-weight: bold;
      color: #333;
      font-size: 1.1rem;
      flex: 1;
    }
    .card-preview {
      font-size: 0.85rem;
      color: #666;
      margin-top: 8px;
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .expand-icon {
      font-size: 1.5rem;
      color: #1e3a5f;
      transition: transform 0.3s;
      user-select: none;
    }
    .expand-icon.expanded {
      transform: rotate(180deg);
    }
    .card-details {
      display: none;
      margin-top: 15px;
      padding-top: 15px;
      border-top: 2px solid rgba(0,0,0,0.1);
    }
    .card-details.visible {
      display: block;
    }
    .detail-row {
      display: flex;
      margin-bottom: 8px;
      font-size: 0.9rem;
    }
    .detail-label {
      font-weight: 600;
      color: #333;
      min-width: 140px;
    }
    .detail-value {
      color: #666;
    }
    .card-info {
      font-size: 0.9rem;
      color: #666;
      margin-top: 4px;
    }
    
    .loading {
      text-align: center;
      color: #666;
      padding: 40px;
    }
    .empty-state {
      text-align: center;
      color: #999;
      padding: 40px;
      font-style: italic;
    }
    
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
      .reply-input-group { flex-direction: column; }
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
  <div style="display: flex; align-items: center; justify-content: center; margin-bottom: 30px;">
    <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='60' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2'%3E%3Cpath d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'%3E%3C/path%3E%3C/svg%3E" alt="Jerry AI" style="width: 60px; height: 60px; margin-right: 15px;">
    <h1>🤖 Jerry AI Dashboard</h1>
  </div>

  <!-- Stats Dashboard -->
  <div class="stats" id="stats-container">
    <div class="stat-card">
      <h3>Total Conversations</h3>
      <div class="number" id="stat-total">-</div>
    </div>
    <div class="stat-card">
      <h3>Active Now</h3>
      <div class="number" id="stat-active">-</div>
    </div>
    <div class="stat-card">
      <h3>Converted</h3>
      <div class="number" id="stat-converted">-</div>
    </div>
    <div class="stat-card">
      <h3>This Week</h3>
      <div class="number" id="stat-week">-</div>
    </div>
  </div>

  <!-- Launch Campaign Section -->
  <div class="section">
    <h2>📱 Launch SMS Campaign</h2>
    <div class="launch-form">
      <div class="form-group">
        <label for="campaign-phone">Phone Number:</label>
        <input type="tel" id="campaign-phone" placeholder="+1 (555) 123-4567" required>
      </div>
      <div class="form-group">
        <label for="campaign-message">Message:</label>
        <textarea id="campaign-message" placeholder="Hi! I'm Jerry from the dealership...">Hi! I'm Jerry from the dealership. I saw you might be interested in a vehicle. What are you looking for?</textarea>
      </div>
      <button class="btn-send" onclick="sendCampaign()">Send SMS</button>
      <div class="message-result" id="campaign-result"></div>
    </div>
  </div>

  <!-- Active Conversations -->
  <div class="section">
    <h2>💬 Active Conversations</h2>
    <input type="text" class="search-box" id="search-conversations" placeholder="🔍 Search by phone or name..." onkeyup="filterConversations()">
    <div class="conversation-list" id="conversations-list">
      <div class="loading">Loading conversations...</div>
    </div>
  </div>

  <!-- Appointments -->
  <div class="section">
    <h2>📅 Recent Appointments</h2>
    <div id="appointments-list">
      <div class="loading">Loading appointments...</div>
    </div>
  </div>

  <!-- Callbacks -->
  <div class="section">
    <h2>📞 Callback Requests</h2>
    <div id="callbacks-list">
      <div class="loading">Loading callbacks...</div>
    </div>
  </div>

</div>

<script>
let allConversations = [];

// Load dashboard data
async function loadDashboard() {
  try {
    const response = await fetch('/api/dashboard');
    const data = await response.json();
    
    // Update stats
    document.getElementById('stat-total').textContent = data.stats.total || 0;
    document.getElementById('stat-active').textContent = data.stats.active || 0;
    document.getElementById('stat-converted').textContent = data.stats.converted || 0;
    document.getElementById('stat-week').textContent = data.stats.weekTotal || 0;
    
    // Store and display conversations
    allConversations = data.conversations || [];
    displayConversations(allConversations);
    
    // Display appointments
    displayAppointments(data.appointments || []);
    
    // Display callbacks
    displayCallbacks(data.callbacks || []);
    
  } catch (error) {
    console.error('Error loading dashboard:', error);
  }
}

function displayConversations(conversations) {
  const container = document.getElementById('conversations-list');
  if (conversations.length === 0) {
    container.innerHTML = '<div class="empty-state">No conversations yet. Launch a campaign to get started!</div>';
    return;
  }
  
  container.innerHTML = conversations.map(conv => {
    const badgeClass = conv.status === 'active' ? 'badge-active' : conv.status === 'converted' ? 'badge-converted' : 'badge-stopped';
    return \`
      <div class="conversation-item" data-phone="\${conv.customer_phone}">
        <div class="conversation-header">
          <div class="conversation-info" onclick="toggleMessages('\${conv.customer_phone}')">
            <div>
              <span class="phone">\${formatPhone(conv.customer_phone)}</span>
              <span class="name">\${conv.customer_name || 'Unknown'}</span>
              <span class="badge \${badgeClass}">\${conv.status}</span>
            </div>
            <div class="info">
              \${conv.vehicle_type ? '🚗 ' + conv.vehicle_type : ''} 
              \${conv.budget ? '💰 ' + conv.budget : ''}
              | 📅 \${new Date(conv.started_at).toLocaleDateString()}
            </div>
          </div>
          <button class="btn-delete" onclick="deleteConv('\${conv.customer_phone}', event)" title="Delete">×</button>
        </div>
        <div class="messages-container" id="messages-\${conv.customer_phone}"></div>
      </div>
    \`;
  }).join('');
}

function filterConversations() {
  const search = document.getElementById('search-conversations').value.toLowerCase();
  const filtered = allConversations.filter(conv => 
    conv.customer_phone.toLowerCase().includes(search) ||
    (conv.customer_name && conv.customer_name.toLowerCase().includes(search))
  );
  displayConversations(filtered);
}

async function toggleMessages(phone) {
  const container = document.getElementById(\`messages-\${phone}\`);
  if (container.style.display === 'block') {
    container.style.display = 'none';
    return;
  }
  
  container.innerHTML = '<div class="loading">Loading messages...</div>';
  container.style.display = 'block';
  
  try {
    const response = await fetch(\`/api/conversation/\${phone}\`);
    const data = await response.json();
    
    let html = '<div class="messages-title">💬 Conversation History</div>';
    
    if (data.messages && data.messages.length > 0) {
      html += data.messages.map(msg => \`
        <div class="message \${msg.role}">
          <div class="role">\${msg.role === 'user' ? '👤 Customer' : '🤖 Jerry AI'}</div>
          <div class="content">\${msg.content}</div>
          <div class="time">\${new Date(msg.created_at).toLocaleString()}</div>
        </div>
      \`).join('');
    } else {
      html += '<div class="empty-state">No messages yet</div>';
    }
    
    html += \`
      <div class="reply-form">
        <h4>📤 Send Manual Reply</h4>
        <div class="reply-input-group">
          <input type="text" class="reply-input" id="reply-\${phone}" placeholder="Type your message...">
          <button class="btn-reply" onclick="sendReply('\${phone}')">Send</button>
        </div>
        <div class="reply-status" id="reply-status-\${phone}"></div>
      </div>
    \`;
    
    container.innerHTML = html;
  } catch (error) {
    container.innerHTML = '<div class="empty-state">Error loading messages</div>';
  }
}

async function sendCampaign() {
  const phone = document.getElementById('campaign-phone').value;
  const message = document.getElementById('campaign-message').value;
  const resultDiv = document.getElementById('campaign-result');
  const button = document.querySelector('.btn-send');
  
  if (!phone) {
    showResult(resultDiv, 'Please enter a phone number', 'error');
    return;
  }
  
  button.disabled = true;
  button.textContent = 'Sending...';
  
  try {
    const response = await fetch('/api/start-sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, message })
    });
    const data = await response.json();
    
    if (data.success) {
      showResult(resultDiv, '✅ SMS sent successfully!', 'success');
      document.getElementById('campaign-phone').value = '';
      setTimeout(() => loadDashboard(), 1000);
    } else {
      showResult(resultDiv, '❌ ' + (data.error || 'Failed to send SMS'), 'error');
    }
  } catch (error) {
    showResult(resultDiv, '❌ Error: ' + error.message, 'error');
  }
  
  button.disabled = false;
  button.textContent = 'Send SMS';
}

async function sendReply(phone) {
  const input = document.getElementById(\`reply-\${phone}\`);
  const message = input.value;
  const statusDiv = document.getElementById(\`reply-status-\${phone}\`);
  
  if (!message) {
    showResult(statusDiv, 'Please enter a message', 'error');
    return;
  }
  
  try {
    const response = await fetch('/api/manual-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, message })
    });
    const data = await response.json();
    
    if (data.success) {
      showResult(statusDiv, '✅ Reply sent!', 'success');
      input.value = '';
      setTimeout(() => toggleMessages(phone), 1000);
    } else {
      showResult(statusDiv, '❌ ' + (data.error || 'Failed to send'), 'error');
    }
  } catch (error) {
    showResult(statusDiv, '❌ Error: ' + error.message, 'error');
  }
}

async function deleteConv(phone, event) {
  event.stopPropagation();
  if (!confirm('Delete this conversation and all its messages?')) return;
  
  try {
    const response = await fetch(\`/api/conversation/\${phone}\`, { method: 'DELETE' });
    const data = await response.json();
    
    if (data.success) {
      loadDashboard();
    } else {
      alert('Error: ' + (data.error || 'Failed to delete'));
    }
  } catch (error) {
    alert('Error: ' + error.message);
  }
}

function displayAppointments(appointments) {
  const container = document.getElementById('appointments-list');
  if (appointments.length === 0) {
    container.innerHTML = '<div class="empty-state">No appointments scheduled</div>';
    return;
  }
  
  container.innerHTML = appointments.map(apt => \`
    <div class="appointment-card" onclick="this.querySelector('.card-details').classList.toggle('visible'); this.querySelector('.expand-icon').classList.toggle('expanded')">
      <div class="card-header">
        <div class="card-title">\${apt.customer_name || 'Unknown'}</div>
        <span class="expand-icon">▼</span>
      </div>
      <div class="card-preview">📅 \${apt.datetime || 'TBD'} | 🚗 \${apt.vehicle_type || 'Any'}</div>
      <div class="card-details">
        <div class="detail-row"><span class="detail-label">Phone:</span><span class="detail-value">\${formatPhone(apt.customer_phone)}</span></div>
        <div class="detail-row"><span class="detail-label">Budget:</span><span class="detail-value">\${apt.budget || 'Not specified'}</span></div>
        <div class="detail-row"><span class="detail-label">Amount:</span><span class="detail-value">$\${apt.budget_amount || 'N/A'}</span></div>
        <div class="detail-row"><span class="detail-label">Created:</span><span class="detail-value">\${new Date(apt.created_at).toLocaleString()}</span></div>
      </div>
    </div>
  \`).join('');
}

function displayCallbacks(callbacks) {
  const container = document.getElementById('callbacks-list');
  if (callbacks.length === 0) {
    container.innerHTML = '<div class="empty-state">No callback requests</div>';
    return;
  }
  
  container.innerHTML = callbacks.map(cb => \`
    <div class="callback-card" onclick="this.querySelector('.card-details').classList.toggle('visible'); this.querySelector('.expand-icon').classList.toggle('expanded')">
      <div class="card-header">
        <div class="card-title">\${cb.customer_name || 'Unknown'}</div>
        <span class="expand-icon">▼</span>
      </div>
      <div class="card-preview">📞 \${cb.datetime || 'ASAP'} | 🚗 \${cb.vehicle_type || 'Any'}</div>
      <div class="card-details">
        <div class="detail-row"><span class="detail-label">Phone:</span><span class="detail-value">\${formatPhone(cb.customer_phone)}</span></div>
        <div class="detail-row"><span class="detail-label">Budget:</span><span class="detail-value">\${cb.budget || 'Not specified'}</span></div>
        <div class="detail-row"><span class="detail-label">Amount:</span><span class="detail-value">$\${cb.budget_amount || 'N/A'}</span></div>
        <div class="detail-row"><span class="detail-label">Created:</span><span class="detail-value">\${new Date(cb.created_at).toLocaleString()}</span></div>
      </div>
    </div>
  \`).join('');
}

function formatPhone(phone) {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    return '+1 (' + cleaned.slice(1,4) + ') ' + cleaned.slice(4,7) + '-' + cleaned.slice(7);
  }
  return phone;
}

function showResult(element, message, type) {
  element.textContent = message;
  element.className = 'message-result ' + type;
  element.style.display = 'block';
  setTimeout(() => { element.style.display = 'none'; }, 5000);
}

// Load dashboard on page load
loadDashboard();
setInterval(loadDashboard, 30000); // Refresh every 30 seconds
</script>
</body>
</html>
  `);
});

// API: Get dashboard data
app.get('/api/dashboard', async (req, res) => {
  const client = await pool.connect();
  try {
    const conversations = await client.query('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 50');
    const appointments = await client.query('SELECT * FROM appointments ORDER BY created_at DESC LIMIT 20');
    const callbacks = await client.query('SELECT * FROM callbacks ORDER BY created_at DESC LIMIT 20');
    
    const stats = await client.query("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active, SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) as converted, SUM(CASE WHEN started_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as week_total FROM conversations");
    
    res.json({
      conversations: conversations.rows,
      appointments: appointments.rows,
      callbacks: callbacks.rows,
      stats: {
        total: parseInt(stats.rows[0].total),
        active: parseInt(stats.rows[0].active),
        converted: parseInt(stats.rows[0].converted),
        weekTotal: parseInt(stats.rows[0].week_total)
      }
    });
  } catch (error) {
    console.error('❌ Dashboard error:', error);
    res.json({ error: error.message });
  } finally {
    client.release();
  }
});

// API: Get conversations list
app.get('/api/conversations', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM conversations ORDER BY updated_at DESC');
    res.json({ conversations: result.rows });
  } catch (error) {
    console.error('❌ Error fetching conversations:', error);
    res.json({ error: error.message });
  } finally {
    client.release();
  }
});

// API: Get single conversation with messages
app.get('/api/conversation/:phone', async (req, res) => {
  const client = await pool.connect();
  try {
    const { phone } = req.params;
    const conversation = await client.query('SELECT * FROM conversations WHERE customer_phone = $1 ORDER BY started_at DESC LIMIT 1', [phone]);
    const messages = await client.query('SELECT * FROM messages WHERE customer_phone = $1 ORDER BY created_at ASC', [phone]);
    
    res.json({
      conversation: conversation.rows[0] || null,
      messages: messages.rows
    });
  } catch (error) {
    console.error('❌ Error fetching conversation:', error);
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
    res.json({ success: deleted });
  } catch (error) {
    console.error('❌ Error deleting conversation:', error);
    res.json({ success: false, error: error.message });
  }
});

// API: Start SMS Campaign - **FIXED VERSION**
app.post('/api/start-sms', async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    if (!phone) {
      return res.json({ success: false, error: 'Phone number required' });
    }
    
    // Check if customer already has an active conversation
    const hasActive = await hasActiveConversation(phone);
    if (hasActive) {
      return res.json({ success: false, error: 'This customer already has an active conversation.' });
    }

    const messageBody = message || "Hi! I'm Jerry from the dealership. I saw you might be interested in a vehicle. What are you looking for?";
    
    // Create or update customer & conversation
    await getOrCreateCustomer(phone);
    await getOrCreateConversation(phone);
    await logAnalytics('sms_sent', phone, { source: 'manual_campaign', message: messageBody });

    // Send SMS via Twilio - FIXED: Using global twilioClient
    await twilioClient.messages.create({
      body: messageBody,
      from: TWILIO_FROM_NUMBER,
      to: phone
    });

    console.log('📱 SMS sent to:', phone);
    res.json({ success: true, message: 'SMS sent!' });
    
  } catch (error) {
    console.error('❌ Error sending SMS:', error);
    res.json({ success: false, error: error.message });
  }
});

// API: Manual Reply - **FIXED VERSION**
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

    // Send SMS via Twilio - FIXED: Using global twilioClient
    await twilioClient.messages.create({
      body: message,
      from: TWILIO_FROM_NUMBER,
      to: phone
    });

    console.log('📱 Manual reply sent to:', phone);
    res.json({ success: true, message: 'Reply sent!' });
    
  } catch (error) {
    console.error('❌ Error sending manual reply:', error);
    res.json({ success: false, error: error.message });
  }
});
// API: SMS Webhook (Twilio incoming messages)
app.post('/api/sms-webhook', async (req, res) => {
  try {
    const { From: phone, Body: userMessage } = req.body;
    
    console.log('📨 Incoming SMS from:', phone, '- Message:', userMessage);

    // Get or create conversation
    const conversation = await getOrCreateConversation(phone);
    await saveMessage(conversation.id, phone, 'user', userMessage);
    await logAnalytics('sms_received', phone, { message: userMessage });

    // Check for stop keywords
    const stopWords = ['stop', 'unsubscribe', 'cancel', 'quit', 'end'];
    if (stopWords.some(word => userMessage.toLowerCase().includes(word))) {
      await updateConversation(conversation.id, { status: 'stopped' });
      await logAnalytics('conversation_stopped', phone, { reason: 'user_request' });
      
      await twilioClient.messages.create({
        body: "Got it! You've been unsubscribed. Thanks for your time!",
        from: TWILIO_FROM_NUMBER,
        to: phone
      });
      
      return res.status(200).send('OK');
    }

    // Call Perplexity AI for response
    const aiResponse = await getPerplexityResponse(userMessage, conversation);
    
    if (aiResponse) {
      await saveMessage(conversation.id, phone, 'assistant', aiResponse.message);
      
      // Update conversation with extracted info
      if (aiResponse.updates) {
        await updateConversation(conversation.id, aiResponse.updates);
      }
      
      // Handle appointment booking
      if (aiResponse.action === 'book_appointment' && aiResponse.appointmentData) {
        await saveAppointment({
          phone: phone,
          name: aiResponse.appointmentData.name,
          vehicleType: aiResponse.appointmentData.vehicleType,
          budget: aiResponse.appointmentData.budget,
          budgetAmount: aiResponse.appointmentData.budgetAmount,
          datetime: aiResponse.appointmentData.datetime
        });
        await updateConversation(conversation.id, { status: 'converted' });
        await logAnalytics('appointment_booked', phone, aiResponse.appointmentData);
        
        // Send email notification
        await sendEmailNotification(
          '🚗 New Appointment Booked',
          `<h2>New Appointment</h2>
           <p><strong>Customer:</strong> ${aiResponse.appointmentData.name}</p>
           <p><strong>Phone:</strong> ${phone}</p>
           <p><strong>Vehicle:</strong> ${aiResponse.appointmentData.vehicleType}</p>
           <p><strong>Budget:</strong> ${aiResponse.appointmentData.budget}</p>
           <p><strong>Date/Time:</strong> ${aiResponse.appointmentData.datetime}</p>`
        );
      }
      
      // Handle callback request
      if (aiResponse.action === 'schedule_callback' && aiResponse.callbackData) {
        await saveCallback({
          phone: phone,
          name: aiResponse.callbackData.name,
          vehicleType: aiResponse.callbackData.vehicleType,
          budget: aiResponse.callbackData.budget,
          budgetAmount: aiResponse.callbackData.budgetAmount,
          datetime: aiResponse.callbackData.datetime
        });
        await logAnalytics('callback_requested', phone, aiResponse.callbackData);
        
        // Send email notification
        await sendEmailNotification(
          '📞 New Callback Request',
          `<h2>Callback Requested</h2>
           <p><strong>Customer:</strong> ${aiResponse.callbackData.name}</p>
           <p><strong>Phone:</strong> ${phone}</p>
           <p><strong>Vehicle:</strong> ${aiResponse.callbackData.vehicleType}</p>
           <p><strong>Time:</strong> ${aiResponse.callbackData.datetime}</p>`
        );
      }
      
      // Send AI response via SMS
      await twilioClient.messages.create({
        body: aiResponse.message,
        from: TWILIO_FROM_NUMBER,
        to: phone
      });
      
      console.log('🤖 AI response sent to:', phone);
    }

    res.status(200).send('OK');
    
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).send('Error');
  }
});

// Perplexity AI Integration
async function getPerplexityResponse(userMessage, conversation) {
  try {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) {
      console.log('⚠️ Perplexity API key not configured');
      return {
        message: "Thanks for your message! A team member will get back to you soon."
      };
    }

    const systemPrompt = `You are Jerry, a friendly car dealership AI assistant. Your job is to:
1. Qualify leads by asking about their vehicle needs, budget, and timeline
2. Schedule appointments or callbacks
3. Be conversational and helpful
4. Extract key information: name, vehicle type, budget range, preferred time

Current conversation context:
- Customer name: ${conversation.customer_name || 'Unknown'}
- Vehicle interest: ${conversation.vehicle_type || 'Not specified'}
- Budget: ${conversation.budget || 'Not specified'}

Rules:
- Keep responses under 160 characters when possible
- Be friendly and casual
- Ask one question at a time
- If customer wants to book, confirm details and say "Great! I'll have someone reach out to confirm."`;

    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-sonar-small-128k-online',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.7,
        max_tokens: 200
      })
    });

    if (!response.ok) {
      throw new Error('Perplexity API error: ' + response.statusText);
    }

    const data = await response.json();
    const aiMessage = data.choices[0].message.content;

    // Extract information from conversation
    const updates = {};
    const lowerMessage = userMessage.toLowerCase();
    
    // Extract name
    const nameMatch = userMessage.match(/(?:my name is|i'm|im|i am|this is)\s+([a-z]+(?:\s+[a-z]+)?)/i);
    if (nameMatch) {
      updates.customer_name = nameMatch[1].trim();
    }
    
    // Extract vehicle type
    const vehicles = ['sedan', 'suv', 'truck', 'van', 'coupe', 'hatchback', 'convertible', 'wagon'];
    for (const vehicle of vehicles) {
      if (lowerMessage.includes(vehicle)) {
        updates.vehicle_type = vehicle.charAt(0).toUpperCase() + vehicle.slice(1);
        break;
      }
    }
    
    // Extract budget
    const budgetMatch = userMessage.match(/\$?(\d{1,3}(?:,?\d{3})*(?:\.\d{2})?)/);
    if (budgetMatch) {
      const amount = parseFloat(budgetMatch[1].replace(/,/g, ''));
      if (amount > 5000) {
        updates.budget_amount = amount;
        if (amount < 15000) updates.budget = 'Under $15k';
        else if (amount < 25000) updates.budget = '$15k-$25k';
        else if (amount < 35000) updates.budget = '$25k-$35k';
        else updates.budget = 'Over $35k';
      }
    }

    // Detect appointment intent
    const appointmentKeywords = ['book', 'schedule', 'appointment', 'visit', 'come in', 'stop by', 'meet'];
    const hasAppointmentIntent = appointmentKeywords.some(keyword => lowerMessage.includes(keyword));
    
    if (hasAppointmentIntent && updates.customer_name) {
      return {
        message: aiMessage,
        updates: updates,
        action: 'book_appointment',
        appointmentData: {
          name: updates.customer_name || conversation.customer_name || 'Unknown',
          vehicleType: updates.vehicle_type || conversation.vehicle_type || 'Any',
          budget: updates.budget || conversation.budget || 'Not specified',
          budgetAmount: updates.budget_amount || conversation.budget_amount || 0,
          datetime: 'TBD - Team will call to confirm'
        }
      };
    }
    
    // Detect callback intent
    const callbackKeywords = ['call me', 'call back', 'phone me', 'reach out', 'contact me'];
    const hasCallbackIntent = callbackKeywords.some(keyword => lowerMessage.includes(keyword));
    
    if (hasCallbackIntent) {
      return {
        message: aiMessage,
        updates: updates,
        action: 'schedule_callback',
        callbackData: {
          name: updates.customer_name || conversation.customer_name || 'Unknown',
          vehicleType: updates.vehicle_type || conversation.vehicle_type || 'Any',
          budget: updates.budget || conversation.budget || 'Not specified',
          budgetAmount: updates.budget_amount || conversation.budget_amount || 0,
          datetime: 'ASAP'
        }
      };
    }

    return {
      message: aiMessage,
      updates: Object.keys(updates).length > 0 ? updates : null
    };

  } catch (error) {
    console.error('❌ Perplexity AI error:', error);
    return {
      message: "Thanks for reaching out! A team member will contact you shortly."
    };
  }
}

// Test email endpoint
app.get('/test-email', async (req, res) => {
  try {
    const result = await sendEmailNotification('Test Email', '<h1>Test</h1><p>Email system working! Test: ' + new Date().toLocaleString() + '</p>');
    res.json({ success: result, message: result ? '✅ Email sent!' : '❌ Not configured' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Export Appointments CSV
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

// Export Callbacks CSV
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

// Export Conversations CSV
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

// Export Analytics CSV
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

// Start server
app.listen(PORT, HOST, () => {
  console.log(`✅ Jerry AI Backend - Database Edition - Port ${PORT}`);
});
