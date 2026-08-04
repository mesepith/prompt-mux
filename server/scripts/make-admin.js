/**
 * Grant or revoke admin access from the command line.
 *
 *   npm --prefix server run make-admin -- me@example.com
 *   npm --prefix server run make-admin -- me@example.com --revoke
 *   npm --prefix server run make-admin -- --list
 *
 * ADMIN_EMAILS in server/.env is the usual way to create the first admin (the
 * address is promoted on sign-in). This script is the escape hatch for the cases
 * that variable can't cover: revoking someone, checking who has access, or
 * promoting an address you don't want left in a config file.
 *
 * The account must already exist — this never creates users or touches passwords.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { connectDB } = await import('../src/config/db.js');
const { User } = await import('../src/models/User.js');

const args = process.argv.slice(2);
const revoke = args.includes('--revoke');
const list = args.includes('--list');
const email = args.find((a) => !a.startsWith('--'))?.trim().toLowerCase();

function usage(message) {
  if (message) console.error(`\n${message}`);
  console.error(`
Usage:
  npm --prefix server run make-admin -- <email>            grant admin
  npm --prefix server run make-admin -- <email> --revoke   revoke admin
  npm --prefix server run make-admin -- --list             show current admins
`);
  process.exit(message ? 1 : 0);
}

if (!list && !email) usage('An email address is required.');

await connectDB();

try {
  if (list) {
    const admins = await User.find({ role: 'admin' }).select('email verified createdAt').lean();
    if (!admins.length) {
      console.log(
        'No admins yet. Set ADMIN_EMAILS in server/.env and sign in, or run this script with an email.'
      );
    } else {
      console.log(`${admins.length} admin(s):`);
      for (const a of admins) {
        console.log(`  ${a.email}${a.verified ? '' : '  (email not verified)'}`);
      }
    }
  } else {
    const user = await User.findOne({ email });
    if (!user) {
      console.error(
        `No account for ${email}. Sign up in the app first — this script only changes an existing user's role.`
      );
      process.exitCode = 1;
    } else {
      const nextRole = revoke ? 'user' : 'admin';
      if (user.role === nextRole) {
        console.log(`${email} is already ${nextRole === 'admin' ? 'an admin' : 'a regular user'}.`);
      } else {
        user.role = nextRole;
        await user.save();
        console.log(`${email} is now ${nextRole === 'admin' ? 'an admin' : 'a regular user'}.`);
        if (nextRole === 'user') {
          console.log(
            'Note: if this address is still listed in ADMIN_EMAILS it will be promoted again on the next sign-in.'
          );
        }
      }
    }
  }
} finally {
  await mongoose.disconnect();
}
