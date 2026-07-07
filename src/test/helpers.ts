import { buildApp } from '../app.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

export async function getTestApp() {
  if (!app) {
    process.env.MOCK = '1';
    process.env.JWT_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgKnd4fAuc+FXK1z/q
12QfxiXHEPk1q/rOINDU//Qm3q2hRANCAAT526jHPR+zVP4+EY5MQQylBb9CGU/Q
JmaH9joZYDM+e4xUKkv5p8KLQ6ybwp5IcFxY19kPYJUur3cA0tx1N2/g
-----END PRIVATE KEY-----`;
    process.env.JWT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE+duoxz0fs1T+PhGOTEEMpQW/QhlP
0CZmh/Y6GWAzPnuMVCpL+afCi0Osm8KeSHBcWNfZD2CVLq93ANLcdTdv4A==
-----END PUBLIC KEY-----`;
    // Fastify v5: buildApp returns an instance flavored by its custom
    // loggerInstance (pino Logger), which doesn't unify with the plain
    // FastifyInstance (FastifyBaseLogger). Same instance at runtime.
    app = (await buildApp()) as unknown as FastifyInstance;
    await app.ready();
  }
  return app;
}

export async function closeTestApp() {
  if (app) {
    await app.close();
    app = undefined as any;
  }
}
