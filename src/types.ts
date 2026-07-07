export interface AuthUser {
  id: string;
  role: 'student' | 'academy';
  academy_id?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
  }
  interface FastifyInstance {
    requireAuth: (role?: 'student' | 'academy') => (req: FastifyRequest) => Promise<void>;
  }
}
