import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTestApp, closeTestApp } from './helpers.js';

describe('Attendance Flow', () => {
  let app: any;
  let studentToken: string;
  let academyToken: string;

  beforeAll(async () => {
    app = await getTestApp();

    // Create student
    const studentOtp = await app.inject({
      method: 'POST',
      url: '/auth/otp/request',
      payload: { phone: '9876543214', role: 'student' },
    });
    const studentVerify = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { otp_id: JSON.parse(studentOtp.body).otp_id, code: '123456' },
    });
    studentToken = JSON.parse(studentVerify.body).access_token;

    // Create academy (mock returns academy for any phone with role=academy)
    const academyOtp = await app.inject({
      method: 'POST',
      url: '/auth/otp/request',
      payload: { phone: '9876543215', role: 'academy' },
    });
    const academyVerify = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { otp_id: JSON.parse(academyOtp.body).otp_id, code: '123456' },
    });
    academyToken = JSON.parse(academyVerify.body).access_token;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('should get me with attendance OTP', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.attendance_otp).toBeDefined();
    expect(body.attendance_otp.length).toBe(4);
  });

  it('should get studio dashboard', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/studio/dashboard',
      headers: { Authorization: `Bearer ${academyToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.inbox_counts).toBeDefined();
    expect(body.active_trials).toBeDefined();
  });

  it('should get studio inbox', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/studio/inbox',
      headers: { Authorization: `Bearer ${academyToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.counts).toBeDefined();
  });
});
