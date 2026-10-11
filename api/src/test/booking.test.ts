import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTestApp, closeTestApp } from './helpers.js';

describe('Booking Flow', () => {
  let app: any;
  let accessToken: string;

  beforeAll(async () => {
    app = await getTestApp();

    const otpRes = await app.inject({
      method: 'POST',
      url: '/auth/otp/request',
      payload: { phone: '9876543213', role: 'student' },
    });
    const { otp_id } = JSON.parse(otpRes.body);

    const verifyRes = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { otp_id, code: '123456' },
    });
    accessToken = JSON.parse(verifyRes.body).access_token;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('should list academies', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/academies',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.items)).toBe(true);
  });

  it('should create a booking', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/bookings',
      headers: { Authorization: `Bearer ${accessToken}` },
      payload: { batch_id: 'test-batch-1', slot_id: 'test-slot-1' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.booking).toBeDefined();
    expect(body.payment_intent).toBeDefined();
    expect(body.payment_intent.razorpay_order_id).toBeDefined();
  });

  it('should create a payment order', async () => {
    const bookingRes = await app.inject({
      method: 'POST',
      url: '/bookings',
      headers: { Authorization: `Bearer ${accessToken}` },
      payload: { batch_id: 'test-batch-2', slot_id: 'test-slot-2' },
    });
    const { booking } = JSON.parse(bookingRes.body);

    const res = await app.inject({
      method: 'POST',
      url: '/payments/order',
      headers: { Authorization: `Bearer ${accessToken}` },
      payload: { booking_id: booking.id },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.razorpay_order_id).toBeDefined();
    expect(body.amount_paise).toBeGreaterThan(0);
  });
});
