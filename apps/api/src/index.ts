import type { Env } from "./types";
export { GameRoom } from "./GameRoom";

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const headers = corsHeaders(env.ALLOWED_ORIGIN);

    if (req.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    // /room/:roomId/start | /room/:roomId/state | /room/:roomId/ws
    const match = url.pathname.match(/^\/room\/([^/]+)\/(start|state|ws)$/);
    if (match) {
      const [, roomId] = match;
      const id = env.GAME_ROOM.idFromName(roomId);
      const stub = env.GAME_ROOM.get(id);
      const resp = await stub.fetch(req);

      // WebSocketアップグレード応答にはCORSヘッダーを付与できないのでそのまま返す
      if (resp.webSocket) return resp;

      const merged = new Headers(resp.headers);
      Object.entries(headers).forEach(([k, v]) => merged.set(k, v));
      return new Response(resp.body, { status: resp.status, headers: merged });
    }

    if (url.pathname === "/health") {
      return new Response("ok", { headers });
    }

    return new Response("not found", { status: 404, headers });
  },
};
