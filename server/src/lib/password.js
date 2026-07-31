import bcrypt from 'bcryptjs';

const ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 10;

export async function hashPassword(password) {
  return bcrypt.hash(password, ROUNDS);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function isPasswordStrong(password) {
  return typeof password === 'string' && password.length >= 6;
}
