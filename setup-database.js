const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function setupDatabase() {
  const client = await pool.connect();
  
  try {
    console.log('🔧 Setting up database...');

    // Create customers table
    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(20) UNIQUE NOT NULL,
        name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_contact TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Created customers table');

    // Create conversations table
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        customer_phone VARCHAR(20) NOT NULL,
        status VARCHAR(50) DEFAULT 'active',
        stage VARCHAR(50) DEFAULT 'greeting',
        vehicle_type VARCHAR(100),
        budget VARCHAR(50),
        budget_amount INTEGER,
        intent VARCHAR(50),
        customer_name VARCHAR(255),
        datetime VARCHAR(255),
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_phone) REFERENCES customers(phone)
      );
    `);
    console.log('✅ Created conversations table');

    // Create messages table
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        customer_phone VARCHAR(20) NOT NULL,
        role VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id),
        FOREIGN KEY (customer_phone) REFERENCES customers(phone)
      );
    `);
    console.log('✅ Created messages table');

    // Create appointments table
    await client.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id SERIAL PRIMARY KEY,
        customer_phone VARCHAR(20) NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        vehicle_type VARCHAR(100),
        budget VARCHAR(50),
        budget_amount INTEGER,
        datetime VARCHAR(255),
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_phone) REFERENCES customers(phone)
      );
    `);
    console.log('✅ Created appointments table');

    // Create callbacks table
    await client.query(`
      CREATE TABLE IF NOT EXISTS callbacks (
        id SERIAL PRIMARY KEY,
        customer_phone VARCHAR(20) NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        vehicle_type VARCHAR(100),
        budget VARCHAR(50),
        budget_amount INTEGER,
        datetime VARCHAR(255),
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_phone) REFERENCES customers(phone)
      );
    `);
    console.log('✅ Created callbacks table');

    // Create analytics table
    await client.query(`
      CREATE TABLE IF NOT EXISTS analytics (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(100) NOT NULL,
        customer_phone VARCHAR(20),
        data JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Created analytics table');

    // Create indexes for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(customer_phone);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(customer_phone);
      CREATE INDEX IF NOT EXISTS idx_appointments_phone ON appointments(customer_phone);
      CREATE INDEX IF NOT EXISTS idx_callbacks_phone ON callbacks(customer_phone);
    `);
    console.log('✅ Created indexes');

    console.log('🎉 Database setup complete!');
    
  } catch (error) {
    console.error('❌ Database setup error:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

setupDatabase();
