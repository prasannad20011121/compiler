import bcrypt from 'bcryptjs';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';

export const authRouter = Router();

function sign(user) {
  return jwt.sign({ sub: user._id.toString(), email: user.email }, process.env.JWT_SECRET, {
    expiresIn: '30d',
  });
}

function validCredentials(email, password) {
  return (
    typeof email === 'string' &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) &&
    typeof password === 'string' &&
    password.length >= 8
  );
}

authRouter.post('/register', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!validCredentials(email, password)) {
    return res.status(400).json({ error: 'valid email and password (min 8 chars) required' });
  }
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) return res.status(409).json({ error: 'account already exists' });
  const user = await User.create({
    email,
    passwordHash: await bcrypt.hash(password, 10),
  });
  res.status(201).json({ token: sign(user), email: user.email });
});

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  const user = await User.findOne({ email: (email ?? '').toLowerCase() });
  if (!user || !(await bcrypt.compare(password ?? '', user.passwordHash))) {
    return res.status(401).json({ error: 'invalid email or password' });
  }
  res.json({ token: sign(user), email: user.email });
});
