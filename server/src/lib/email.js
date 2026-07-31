import nodemailer from 'nodemailer';

const OTP_EXPIRY_MINUTES = Number(process.env.OTP_EXPIRY_MINUTES) || 10;

function appName() {
  return (process.env.APP_NAME || 'PromptMux').trim();
}

const transport = () => {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;

  if (!host || !user || !pass) {
    throw new Error('SMTP_HOST, SMTP_USER and SMTP_PASS must be set to send email');
  }

  const secureSetting = process.env.SMTP_SECURE;
  const secure = secureSetting ? secureSetting === 'true' : port === 465;

  return {
    transporter: nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    }),
    from,
  };
};

function baseTemplate({ subject, headline, body, code, actionLabel, footer }) {
  const brand = appName();
  const primaryColor = '#6366f1'; // indigo-500
  const bgColor = '#f8fafc'; // slate-50
  const cardColor = '#ffffff';
  const textColor = '#1f2937'; // gray-800
  const mutedColor = '#6b7280'; // gray-500
  const borderColor = '#e5e7eb'; // gray-200

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${subject}</title>
  <style>
    @media only screen and (max-width: 600px) {
      .container { width: 100% !important; padding: 16px !important; }
      .code { font-size: 36px !important; letter-spacing: 12px !important; }
      .headline { font-size: 22px !important; }
    }
  </style>
</head>
<body style="margin:0; padding:0; background-color:${bgColor}; font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" class="container" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px; width:100%; background:${cardColor}; border-radius:20px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.06);">
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%); padding:40px 40px 32px; text-align:center;">
              <div style="color:#ffffff; font-size:24px; font-weight:800; letter-spacing:-0.02em;">${brand}</div>
              <div style="color:rgba(255,255,255,0.85); font-size:14px; margin-top:6px;">Secure access to your chats</div>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              <h1 class="headline" style="margin:0 0 16px; color:${textColor}; font-size:26px; font-weight:700; line-height:1.25;">${headline}</h1>
              <p style="margin:0 0 28px; color:${mutedColor}; font-size:16px; line-height:1.6;">${body}</p>

              <div style="text-align:center; margin:32px 0;">
                <div style="display:inline-block; background:#f3f4f6; border:1px solid ${borderColor}; border-radius:16px; padding:24px 40px;">
                  <div style="color:${mutedColor}; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.08em; margin-bottom:12px;">${actionLabel}</div>
                  <div class="code" style="color:${textColor}; font-size:44px; font-weight:800; letter-spacing:16px; font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace;">${code}</div>
                </div>
              </div>

              <p style="margin:24px 0 0; color:${mutedColor}; font-size:14px; line-height:1.6; text-align:center;">
                This code expires in <strong style="color:${textColor};">${OTP_EXPIRY_MINUTES} minutes</strong>.<br>
                If you didn't request this, you can safely ignore this email.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:24px 40px; border-top:1px solid ${borderColor}; text-align:center;">
              <p style="margin:0; color:${mutedColor}; font-size:13px; line-height:1.5;">${footer}</p>
              <p style="margin:12px 0 0; color:${mutedColor}; font-size:12px;">&copy; ${new Date().getFullYear()} ${brand}. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendOtpEmail({ email, code, purpose }) {
  const brand = appName();
  const { transporter, from } = transport();
  const isRegister = purpose === 'register';
  const subject = `${isRegister ? 'Verify' : 'Reset'} your ${brand} account — ${code}`;
  const headline = isRegister ? 'Verify your email address' : 'Reset your password';
  const body = isRegister
    ? `Thanks for signing up for ${brand}. Please use the verification code below to confirm your email address and activate your account.`
    : `We received a request to reset your ${brand} password. Use the code below to continue. If you didn't make this request, you can safely ignore this email.`;
  const actionLabel = isRegister ? 'Verification code' : 'Password reset code';
  const footer = `Need help? Reply to this email or contact ${brand} support.`;

  const html = baseTemplate({ subject, headline, body, code, actionLabel, footer });
  const text = [
    `${headline} — ${brand}`,
    '',
    isRegister
      ? `Thanks for signing up for ${brand}. Please use the verification code below to confirm your email address and activate your account.`
      : `We received a request to reset your ${brand} password. Use the code below to continue.`,
    '',
    `${actionLabel}: ${code}`,
    '',
    `This code expires in ${OTP_EXPIRY_MINUTES} minutes.`,
    "If you didn't request this, you can safely ignore this email.",
    '',
    `&copy; ${new Date().getFullYear()} ${brand}. All rights reserved.`,
  ].join('\n');

  await transporter.sendMail({
    from: `${brand} <${from}>`,
    to: email,
    subject,
    text,
    html,
  });
}
