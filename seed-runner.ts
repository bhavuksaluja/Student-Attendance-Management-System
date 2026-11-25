import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDatabase, flushPendingWrites } from './server/db.js';
import { seedInitialData } from './server/seed.js';

dotenv.config();

try {
  const connected = await connectDatabase();
  if (!connected) throw new Error('Could not connect to MongoDB. Check MONGODB_URI.');
  await seedInitialData();
  await flushPendingWrites();
  console.log('Seed complete. Demo accounts are listed in README.md.');
} catch (error) {
  console.error('Seed failed:', error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
