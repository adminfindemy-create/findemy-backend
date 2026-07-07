import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTestApp, closeTestApp } from './helpers.js';

describe('Auth Flow', () => {
  let app: any;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('should request OTP', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/otp/request',
      payload: { phone: '9876543210', role: 'student' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.otp_id).toBeDefined();
    expect(body.expires_at).toBeDefined();
  });

  it('should verify OTP and return tokens', async () => {
    const otpRes = await app.inject({
      method: 'POST',
      url: '/auth/otp/request',
      payload: { phone: '9876543211', role: 'student' },
    });
    const { otp_id } = JSON.parse(otpRes.body);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { otp_id, code: '123456' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.access_token).toBeDefined();
    expect(body.refresh_token).toBeDefined();
    expect(body.is_new_user).toBeDefined();
  });

  it('should refresh token', async () => {
    const otpRes = await app.inject({
      method: 'POST',
      url: '/auth/otp/request',
      payload: { phone: '9876543212', role: 'student' },
    });
    const { otp_id } = JSON.parse(otpRes.body);

    const verifyRes = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { otp_id, code: '123456' },
    });
    const { refresh_token } = JSON.parse(verifyRes.body);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.access_token).toBeDefined();
    expect(body.refresh_token).toBeDefined();
  });
});
