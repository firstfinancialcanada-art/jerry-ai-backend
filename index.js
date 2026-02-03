const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const twilio = require('twilio');
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
      deleteConversation: 'DELETE /api/conversation/:phone'
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
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
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
    .stat-card h3 { color: #667eea; font-size: 0.9rem; margin-bottom: 10px; text-transform: uppercase; }
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
      border-bottom: 2px solid #667eea; 
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
      border-color: #667eea;
    }
    .form-group textarea {
      min-height: 120px;
      resize: vertical;
    }
    .btn-send {
      background: #667eea;
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
      background: #5568d3;
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
      border-color: #667eea;
      background: #f8f9ff;
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
    .conversation-item .name { color: #667eea; font-size: 0.9rem; margin-left: 10px; }
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
    .badge-converted { background: #667eea; color: white; }
    .badge-stopped { background: #ef4444; color: white; }
    
    .messages-container {
      display: none;
      margin-top: 20px;
      padding: 20px;
      background: #f8f9ff;
      border-radius: 8px;
      border: 2px solid #667eea;
    }
    .messages-title {
      font-weight: bold;
      color: #667eea;
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
      background: #e0e7ff;
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
    .message.user .role { color: #667eea; }
    .message.assistant .role { color: #764ba2; }
    .message .content { color: #333; line-height: 1.5; white-space: pre-wrap; }
    .message .time { font-size: 0.75rem; color: #666; margin-top: 5px; }
    
    .appointment-card {
      padding: 15px;
      background: #f0fdf4;
      border-left: 4px solid #4ade80;
      border-radius: 4px;
      margin-bottom: 15px;
    }
    .callback-card {
      padding: 15px;
      background: #fef3c7;
      border-left: 4px solid #fbbf24;
      border-radius: 4px;
      margin-bottom: 15px;
    }
    .card-title { font-weight: bold; color: #333; margin-bottom: 8px; font-size: 1.1rem; }
    .card-info { font-size: 0.9rem; color: #666; margin-top: 4px; }
    
    .loading { text-align: center; color: #666; padding: 40px; }
    .empty-state { text-align: center; color: #999; padding: 40px; font-style: italic; }
    
    @media (max-width: 768px) {
      h1 { font-size: 1.8rem; }
      .stats { grid-template-columns: repeat(2, 1fr); }
      .section { padding: 20px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚗 Jerry AI Dashboard</h1>
    
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
      <h2>📱 Launch Jerry - Send SMS Campaign</h2>
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
    
    async function loadDashboard() {
      try {
        const statsData = await fetch('/api/dashboard').then(r => r.json());
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
            <div class="appointment-card">
              <div class="card-title">🚗 \${apt.customer_name} - \${apt.vehicle_type}</div>
              <div class="card-info">📞 \${apt.customer_phone}</div>
              <div class="card-info">💰 Budget: \${apt.budget}\${apt.budget_amount ? ' ($' + apt.budget_amount.toLocaleString() + ')' : ''}</div>
              <div class="card-info">📅 Date: \${apt.datetime}</div>
              <div class="card-info">✅ Booked: \${new Date(apt.created_at).toLocaleString()}</div>
            </div>
          \`).join('');
        }
        
        const callbacksList = document.getElementById('callbacksList');
        if (statsData.recentCallbacks.length === 0) {
          callbacksList.innerHTML = '<div class="empty-state">No callback requests yet.</div>';
        } else {
          callbacksList.innerHTML = statsData.recentCallbacks.map(cb => \`
            <div class="callback-card">
              <div class="card-title">📞 \${cb.customer_name} - \${cb.vehicle_type}</div>
              <div class="card-info">📞 \${cb.customer_phone}</div>
              <div class="card-info">💰 Budget: \${cb.budget}\${cb.budget_amount ? ' ($' + cb.budget_amount.toLocaleString() + ')' : ''}</div>
              <div class="card-info">⏰ Preferred Time: \${cb.datetime}</div>
              <div class="card-info">✅ Requested: \${new Date(cb.created_at).toLocaleString()}</div>
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
        
        messagesContainer.innerHTML = '<div class="messages-title">💬 Full Conversation Thread</div>' + 
          data.messages.map(msg => \`
            <div class="message \${msg.role}">
              <div class="role">\${msg.role === 'user' ? '👤 Customer' : '🤖 Jerry AI'}</div>
              <div class="content">\${msg.content}</div>
              <div class="time">\${new Date(msg.created_at).toLocaleString()}</div>
            </div>
          \`).join('');
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
    const appointments = await client.query('SELECT * FROM appointments ORDER BY created_at DESC LIMIT 10');
    const callbacks = await client.query('SELECT * FROM callbacks ORDER BY created_at DESC LIMIT 10');
    
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
    
    await getOrCreateCustomer(phone);
    const conversation = await getOrCreateConversation(phone);
    await saveMessage(conversation.id, phone, 'user', message);
    await touchConversation(conversation.id);
    await logAnalytics('message_received', phone, { message });
    
    const aiResponse = await getJerryResponse(phone, message, conversation);
    
    await saveMessage(conversation.id, phone, 'assistant', aiResponse);
    
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(aiResponse);
    
    console.log('✅ Jerry replied:', aiResponse);
    res.type('text/xml').send(twiml.toString());
  } catch (error) {
    console.error('❌ Webhook error:', error);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("I'm having trouble right now. Please call us at (403) 555-0100!");
    res.type('text/xml').send(twiml.toString());
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
      await logAnalytics('appointment_booked', phone, appointmentData);
      return `✅ Perfect ${conversation.customer_name}! I've booked your test drive for ${message}.\n\n📍 We're in Calgary, Alberta and we deliver all across Canada!\n📧 Confirmation sent!\n\nLooking forward to seeing you! Reply STOP to opt out.`;
    } else {
      await saveCallback(appointmentData);
      await logAnalytics('callback_requested', phone, appointmentData);
      return `✅ Got it ${conversation.customer_name}! One of our managers will call you ${message} with all the details.\n\nWe're excited to help you find your perfect ${conversation.vehicle_type}!\n\nTalk soon! Reply STOP to opt out.`;
    }
  }
  
  if (conversation.stage === 'confirmed') {
    return `Thanks ${conversation.customer_name}! We're all set for ${conversation.datetime}. If you need anything or want to reschedule, just let me know! We're located in Calgary, AB and deliver across Canada.`;
  }
  
  return "Thanks for your message! To help you better, let me know:\n• What type of vehicle? (SUV, Sedan, Truck)\n• Your budget? (e.g., $20k)\n• Test drive or callback?";
}

app.listen(PORT, HOST, () => {
  console.log(`✅ Jerry AI Backend - Database Edition - Port ${PORT}`);
});
