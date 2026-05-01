-- Migration: Create user_settings table for persistent unique IDs
CREATE TABLE IF NOT EXISTS user_settings (
  firebase_uid TEXT PRIMARY KEY,
  unique_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
