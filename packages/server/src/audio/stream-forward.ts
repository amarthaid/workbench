import type { FastifyReply, FastifyRequest } from "fastify";

export async function forwardAudioStream(_opts: {
  userId: string;
  request: FastifyRequest;
  reply: FastifyReply;
  internalUrl?: string;
}): Promise<boolean> {
  return false;
}
