import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env');
}

export const db = createClient(url, key);
